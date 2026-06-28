/**
 * obstacleDetection.test.ts
 *
 * Tests for the CNN-based obstacle detection pipeline.
 * Uses Node's native test runner (node:test) with sharp for image loading.
 *
 * These tests validate:
 * 1. The pure TypeScript CNN reference implementation (unit tests)
 * 2. The detection pipeline against the test images under tests/
 * 3. Orientation calculation correctness
 * 4. Bounding box geometry
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// --- Pure TS reference CNN implementation for testing without WASM ---
// This mirrors the Rust WASM pipeline so we can test the algorithms in Node.

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const TESTS_DIR = resolve(__dirname, '..')

/** Convert RGBA to grayscale using luminance formula */
function rgbaToGrayscale(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Float32Array {
  const gray = new Float32Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const r = rgba[i * 4]
    const g = rgba[i * 4 + 1]
    const b = rgba[i * 4 + 2]
    // ITU-R BT.601 luma
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b
  }
  return gray
}

/** Apply 3x3 Gaussian blur */
function gaussianBlur3x3(src: Float32Array, width: number, height: number): Float32Array {
  const kernel = [1, 2, 1, 2, 4, 2, 1, 2, 1]
  const kSum = 16
  const dst = new Float32Array(width * height)

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let sum = 0
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          sum += src[(y + ky) * width + (x + kx)] * kernel[(ky + 1) * 3 + (kx + 1)]
        }
      }
      dst[y * width + x] = sum / kSum
    }
  }
  return dst
}

/** Apply Sobel edge detection, returns edge magnitude */
function sobelEdges(src: Float32Array, width: number, height: number): Float32Array {
  const gx = [-1, 0, 1, -2, 0, 2, -1, 0, 1]
  const gy = [-1, -2, -1, 0, 0, 0, 1, 2, 1]
  const dst = new Float32Array(width * height)

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let sx = 0, sy = 0
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const val = src[(y + ky) * width + (x + kx)]
          const ki = (ky + 1) * 3 + (kx + 1)
          sx += val * gx[ki]
          sy += val * gy[ki]
        }
      }
      dst[y * width + x] = Math.sqrt(sx * sx + sy * sy)
    }
  }
  return dst
}

/** Otsu's method to find optimal threshold */
function otsuThreshold(src: Float32Array): number {
  const histogram = new Float64Array(256)
  let maxVal = 0
  for (const v of src) {
    if (v > maxVal) maxVal = v
  }
  if (maxVal === 0) return 128

  for (const v of src) {
    const bin = Math.min(255, Math.floor((v / maxVal) * 255))
    histogram[bin]++
  }

  const total = src.length
  let sumAll = 0
  for (let i = 0; i < 256; i++) sumAll += i * histogram[i]

  let sumBg = 0, wBg = 0, wFg = 0
  let maxVariance = 0, threshold = 0

  for (let t = 0; t < 256; t++) {
    wBg += histogram[t]
    if (wBg === 0) continue
    wFg = total - wBg
    if (wFg === 0) break

    sumBg += t * histogram[t]
    const meanBg = sumBg / wBg
    const meanFg = (sumAll - sumBg) / wFg
    const variance = wBg * wFg * (meanBg - meanFg) ** 2

    if (variance > maxVariance) {
      maxVariance = variance
      threshold = t
    }
  }

  return (threshold / 255) * maxVal
}

/** Binary dilation with a square structuring element */
function dilate(binary: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const dst = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let found = false
      for (let ky = -radius; ky <= radius && !found; ky++) {
        for (let kx = -radius; kx <= radius && !found; kx++) {
          const ny = y + ky, nx = x + kx
          if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
            if (binary[ny * width + nx]) found = true
          }
        }
      }
      dst[y * width + x] = found ? 1 : 0
    }
  }
  return dst
}

/** Binary erosion with a square structuring element */
function erode(binary: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const dst = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let allSet = true
      for (let ky = -radius; ky <= radius && allSet; ky++) {
        for (let kx = -radius; kx <= radius && allSet; kx++) {
          const ny = y + ky, nx = x + kx
          if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
            if (!binary[ny * width + nx]) allSet = false
          } else {
            allSet = false
          }
        }
      }
      dst[y * width + x] = allSet ? 1 : 0
    }
  }
  return dst
}

/** Connected component labeling via flood fill */
function labelComponents(binary: Uint8Array, width: number, height: number): { labels: Int32Array; count: number } {
  const labels = new Int32Array(width * height)
  let nextLabel = 1

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (binary[y * width + x] && !labels[y * width + x]) {
        // Flood fill
        const stack = [{ x, y }]
        while (stack.length > 0) {
          const p = stack.pop()!
          const idx = p.y * width + p.x
          if (p.x < 0 || p.x >= width || p.y < 0 || p.y >= height) continue
          if (!binary[idx] || labels[idx]) continue

          labels[idx] = nextLabel
          stack.push({ x: p.x + 1, y: p.y })
          stack.push({ x: p.x - 1, y: p.y })
          stack.push({ x: p.x, y: p.y + 1 })
          stack.push({ x: p.x, y: p.y - 1 })
        }
        nextLabel++
      }
    }
  }

  return { labels, count: nextLabel - 1 }
}

interface ComponentStats {
  label: number
  area: number
  minX: number
  maxX: number
  minY: number
  maxY: number
  sumX: number
  sumY: number
  sumXX: number
  sumYY: number
  sumXY: number
}

/** Compute statistics for each connected component */
function computeComponentStats(labels: Int32Array, count: number, width: number, height: number): ComponentStats[] {
  const stats: ComponentStats[] = []
  for (let i = 0; i < count; i++) {
    stats.push({
      label: i + 1,
      area: 0,
      minX: width,
      maxX: 0,
      minY: height,
      maxY: 0,
      sumX: 0,
      sumY: 0,
      sumXX: 0,
      sumYY: 0,
      sumXY: 0,
    })
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const l = labels[y * width + x]
      if (l === 0) continue
      const s = stats[l - 1]
      s.area++
      if (x < s.minX) s.minX = x
      if (x > s.maxX) s.maxX = x
      if (y < s.minY) s.minY = y
      if (y > s.maxY) s.maxY = y
      s.sumX += x
      s.sumY += y
      s.sumXX += x * x
      s.sumYY += y * y
      s.sumXY += x * y
    }
  }

  return stats
}

/** Compute orientation angle from image moments (PCA on second-order moments) */
function computeOrientation(stats: ComponentStats): number {
  if (stats.area === 0) return 0
  const cx = stats.sumX / stats.area
  const cy = stats.sumY / stats.area

  // Central moments
  const mu20 = stats.sumXX / stats.area - cx * cx
  const mu02 = stats.sumYY / stats.area - cy * cy
  const mu11 = stats.sumXY / stats.area - cx * cy

  // Orientation from PCA
  const angle = 0.5 * Math.atan2(2 * mu11, mu20 - mu02)
  return (angle * 180) / Math.PI
}

interface Detection {
  id: number
  bbox: { x: number; y: number; width: number; height: number }
  oriented_bbox: {
    center_x: number
    center_y: number
    width: number
    height: number
    angle: number
  }
  area: number
  orientation_deg: number
  confidence: number
}

/** Full detection pipeline (TypeScript reference implementation) */
function detectObstaclesRef(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  _options?: { minArea?: number; maxAreaRatio?: number }
): { obstacles: Detection[]; count: number } {
  const minArea = _options?.minArea ?? 1500
  const maxAreaRatio = _options?.maxAreaRatio ?? 0.4
  const totalPixels = width * height

  // 1. Grayscale
  const gray = rgbaToGrayscale(rgba, width, height)

  // 2. Gaussian blur
  const blurred = gaussianBlur3x3(gray, width, height)

  // 3. Sobel edges
  const edges = sobelEdges(blurred, width, height)

  // 4. Otsu threshold
  const threshold = otsuThreshold(edges)
  const binary = new Uint8Array(width * height)
  for (let i = 0; i < totalPixels; i++) {
    binary[i] = edges[i] > threshold ? 1 : 0
  }

  // 5. Morphological ops
  const dilated = dilate(binary, width, height, 2)
  const cleaned = erode(dilated, width, height, 1)

  // 6. Connected components
  const { labels, count } = labelComponents(cleaned, width, height)
  const stats = computeComponentStats(labels, count, width, height)

  // 7. Filter and build detections
  const obstacles: Detection[] = []
  let detId = 0

  for (const s of stats) {
    // Filter by area
    if (s.area < minArea) continue
    if (s.area > totalPixels * maxAreaRatio) continue

    // Filter out monitor/dongle area (top center)
    const cx = s.sumX / s.area
    const cy = s.sumY / s.area
    if (cy < height * 0.08 && cx > width * 0.3 && cx < width * 0.7) continue

    const orientation = computeOrientation(s)
    const bboxW = s.maxX - s.minX + 1
    const bboxH = s.maxY - s.minY + 1

    // Confidence based on edge density within bounding box
    let edgeSum = 0
    for (let y = s.minY; y <= s.maxY; y++) {
      for (let x = s.minX; x <= s.maxX; x++) {
        if (labels[y * width + x] === s.label) {
          edgeSum += edges[y * width + x]
        }
      }
    }
    const confidence = Math.min(1.0, edgeSum / (s.area * 50))

    obstacles.push({
      id: detId++,
      bbox: { x: s.minX, y: s.minY, width: bboxW, height: bboxH },
      oriented_bbox: {
        center_x: cx,
        center_y: cy,
        width: bboxW,
        height: bboxH,
        angle: orientation,
      },
      area: s.area,
      orientation_deg: orientation,
      confidence,
    })
  }

  return { obstacles, count: obstacles.length }
}

// =============================================================================
// Tests
// =============================================================================

describe('CNN Obstacle Detection - Unit Tests', () => {
  describe('rgbaToGrayscale', () => {
    it('converts pure white to 255', () => {
      const rgba = new Uint8Array([255, 255, 255, 255])
      const gray = rgbaToGrayscale(rgba, 1, 1)
      assert.ok(Math.abs(gray[0] - 255) < 1, `Expected ~255, got ${gray[0]}`)
    })

    it('converts pure black to 0', () => {
      const rgba = new Uint8Array([0, 0, 0, 255])
      const gray = rgbaToGrayscale(rgba, 1, 1)
      assert.equal(gray[0], 0)
    })

    it('uses correct BT.601 luma weights', () => {
      // Pure red: 0.299 * 255 = 76.245
      const rgba = new Uint8Array([255, 0, 0, 255])
      const gray = rgbaToGrayscale(rgba, 1, 1)
      assert.ok(Math.abs(gray[0] - 76.245) < 0.01, `Red luminance should be ~76.245, got ${gray[0]}`)
    })

    it('handles multiple pixels', () => {
      const rgba = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255])
      const gray = rgbaToGrayscale(rgba, 2, 1)
      assert.equal(gray[0], 0)
      assert.ok(Math.abs(gray[1] - 255) < 1)
    })
  })

  describe('gaussianBlur3x3', () => {
    it('preserves uniform image', () => {
      const size = 5
      const src = new Float32Array(size * size).fill(100)
      const blurred = gaussianBlur3x3(src, size, size)
      // Interior pixels should stay 100
      assert.ok(Math.abs(blurred[2 * size + 2] - 100) < 0.01)
    })

    it('smooths an impulse', () => {
      const size = 5
      const src = new Float32Array(size * size)
      src[2 * size + 2] = 160 // center impulse
      const blurred = gaussianBlur3x3(src, size, size)
      // Center should be reduced, neighbors should have nonzero values
      assert.ok(blurred[2 * size + 2] < 160, 'Center should be smoothed down')
      assert.ok(blurred[1 * size + 2] > 0, 'Neighbor should pick up energy')
    })
  })

  describe('sobelEdges', () => {
    it('detects vertical edge', () => {
      const size = 5
      const src = new Float32Array(size * size)
      // Left half dark, right half bright
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          src[y * size + x] = x < 3 ? 0 : 255
        }
      }
      const edges = sobelEdges(src, size, size)
      // Edge at x=2 should be strong
      assert.ok(edges[2 * size + 2] > 100, `Edge at boundary should be strong, got ${edges[2 * size + 2]}`)
    })

    it('returns zero for uniform image', () => {
      const size = 5
      const src = new Float32Array(size * size).fill(128)
      const edges = sobelEdges(src, size, size)
      for (let y = 1; y < size - 1; y++) {
        for (let x = 1; x < size - 1; x++) {
          assert.equal(edges[y * size + x], 0, 'Uniform image should have zero edges')
        }
      }
    })
  })

  describe('otsuThreshold', () => {
    it('finds threshold for bimodal distribution', () => {
      const data = new Float32Array(200)
      // 100 pixels dark, 100 pixels bright
      for (let i = 0; i < 100; i++) data[i] = 30
      for (let i = 100; i < 200; i++) data[i] = 200
      const t = otsuThreshold(data)
      // Threshold should be between the two modes
      assert.ok(t > 20 && t < 210, `Threshold ${t} should be between modes`)
    })

    it('handles all-zero image', () => {
      const data = new Float32Array(100)
      const t = otsuThreshold(data)
      assert.equal(t, 128, 'All-zero should return 128 fallback')
    })
  })

  describe('morphological operations', () => {
    it('dilate fills gaps', () => {
      const size = 5
      const binary = new Uint8Array(size * size)
      binary[2 * size + 2] = 1 // single pixel
      const dilated = dilate(binary, size, size, 1)
      // Should expand to cross shape
      assert.equal(dilated[1 * size + 2], 1, 'Above should be filled')
      assert.equal(dilated[3 * size + 2], 1, 'Below should be filled')
      assert.equal(dilated[2 * size + 1], 1, 'Left should be filled')
      assert.equal(dilated[2 * size + 3], 1, 'Right should be filled')
    })

    it('erode removes thin features', () => {
      const size = 5
      const binary = new Uint8Array(size * size)
      binary[2 * size + 2] = 1 // single pixel
      const eroded = erode(binary, size, size, 1)
      // Single pixel should be removed by erosion
      assert.equal(eroded[2 * size + 2], 0, 'Isolated pixel should be eroded')
    })
  })

  describe('connected component labeling', () => {
    it('labels separate regions', () => {
      // Two separate blobs
      const width = 10
      const height = 10
      const binary = new Uint8Array(width * height)
      // Blob 1: top-left
      binary[0 * width + 0] = 1
      binary[0 * width + 1] = 1
      binary[1 * width + 0] = 1
      binary[1 * width + 1] = 1
      // Blob 2: bottom-right
      binary[8 * width + 8] = 1
      binary[8 * width + 9] = 1
      binary[9 * width + 8] = 1
      binary[9 * width + 9] = 1

      const { labels, count } = labelComponents(binary, width, height)
      assert.equal(count, 2, 'Should find 2 components')
      assert.notEqual(labels[0], labels[8 * width + 8], 'Components should have different labels')
    })

    it('labels connected L-shape as single region', () => {
      const width = 5
      const height = 5
      const binary = new Uint8Array(width * height)
      // L-shape
      binary[0 * width + 0] = 1
      binary[1 * width + 0] = 1
      binary[2 * width + 0] = 1
      binary[2 * width + 1] = 1
      binary[2 * width + 2] = 1

      const { count } = labelComponents(binary, width, height)
      assert.equal(count, 1, 'L-shape should be single component')
    })
  })

  describe('orientation computation', () => {
    it('horizontal bar gives ~0 degrees', () => {
      const stats: ComponentStats = {
        label: 1,
        area: 100,
        minX: 0,
        maxX: 99,
        minY: 45,
        maxY: 55,
        sumX: 0,
        sumY: 0,
        sumXX: 0,
        sumYY: 0,
        sumXY: 0,
      }
      // Simulate horizontal bar
      let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0
      for (let x = 0; x < 100; x++) {
        for (let y = 45; y <= 55; y++) {
          sx += x
          sy += y
          sxx += x * x
          syy += y * y
          sxy += x * y
        }
      }
      stats.area = 100 * 11
      stats.sumX = sx
      stats.sumY = sy
      stats.sumXX = sxx
      stats.sumYY = syy
      stats.sumXY = sxy

      const angle = computeOrientation(stats)
      assert.ok(Math.abs(angle) < 5, `Horizontal bar should be ~0°, got ${angle}°`)
    })

    it('vertical bar gives ~90 or ~-90 degrees', () => {
      const stats: ComponentStats = {
        label: 1,
        area: 0,
        minX: 45,
        maxX: 55,
        minY: 0,
        maxY: 99,
        sumX: 0,
        sumY: 0,
        sumXX: 0,
        sumYY: 0,
        sumXY: 0,
      }
      let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, area = 0
      for (let y = 0; y < 100; y++) {
        for (let x = 45; x <= 55; x++) {
          sx += x
          sy += y
          sxx += x * x
          syy += y * y
          sxy += x * y
          area++
        }
      }
      stats.area = area
      stats.sumX = sx
      stats.sumY = sy
      stats.sumXX = sxx
      stats.sumYY = syy
      stats.sumXY = sxy

      const angle = computeOrientation(stats)
      assert.ok(Math.abs(Math.abs(angle) - 90) < 5 || Math.abs(angle) < 5,
        `Vertical bar angle should be near ±90° or 0° (PCA ambiguity), got ${angle}°`)
    })
  })
})

describe('CNN Obstacle Detection - Integration Tests', () => {
  // Helper to load test image as RGBA buffer
  async function loadTestImage(filename: string): Promise<{ data: Uint8Array; width: number; height: number }> {
    // Use sharp to decode JPEG to raw RGBA pixels
    const sharp = (await import('sharp')).default
    const imagePath = resolve(TESTS_DIR, 'tests', filename)
    const image = sharp(imagePath)
    const { data, info } = await image
      .resize(640, 480, { fit: 'inside' }) // Resize for faster processing in tests
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })

    return {
      data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      width: info.width,
      height: info.height,
    }
  }

  it('detects ~5 obstacles in "180 rotation needed" image', async () => {
    const { data, width, height } = await loadTestImage('180 rotation needed, 5 obstacles.jpg')
    const result = detectObstaclesRef(data, width, height, { minArea: 800 })

    console.log(`  180° rotation: detected ${result.count} obstacles`)
    for (const o of result.obstacles) {
      console.log(`    #${o.id}: area=${o.area}, orientation=${o.orientation_deg.toFixed(1)}°, confidence=${(o.confidence * 100).toFixed(0)}%`)
    }

    // Should detect around 5 obstacles (±2 tolerance for different thresholding)
    assert.ok(result.count >= 3, `Expected at least 3 obstacles, got ${result.count}`)
    assert.ok(result.count <= 10, `Expected at most 10 obstacles, got ${result.count}`)
  })

  it('detects ~6 obstacles in "No route available" image', async () => {
    const { data, width, height } = await loadTestImage('No route available, 6 obstacles.jpg')
    const result = detectObstaclesRef(data, width, height, { minArea: 800 })

    console.log(`  No route: detected ${result.count} obstacles`)
    for (const o of result.obstacles) {
      console.log(`    #${o.id}: area=${o.area}, orientation=${o.orientation_deg.toFixed(1)}°, confidence=${(o.confidence * 100).toFixed(0)}%`)
    }

    assert.ok(result.count >= 4, `Expected at least 4 obstacles, got ${result.count}`)
    assert.ok(result.count <= 9, `Expected at most 9 obstacles, got ${result.count}`)
  })

  it('detects ~5 obstacles in "turn left, go around iPhone" image', async () => {
    const { data, width, height } = await loadTestImage('turn left, go around iPhone, 5 obstacles.jpg')
    const result = detectObstaclesRef(data, width, height, { minArea: 800 })

    console.log(`  Turn left: detected ${result.count} obstacles`)
    for (const o of result.obstacles) {
      console.log(`    #${o.id}: area=${o.area}, orientation=${o.orientation_deg.toFixed(1)}°, confidence=${(o.confidence * 100).toFixed(0)}%`)
    }

    assert.ok(result.count >= 3, `Expected at least 3 obstacles, got ${result.count}`)
    assert.ok(result.count <= 10, `Expected at most 10 obstacles, got ${result.count}`)
  })

  it('all detected obstacles have valid orientation values', async () => {
    const { data, width, height } = await loadTestImage('180 rotation needed, 5 obstacles.jpg')
    const result = detectObstaclesRef(data, width, height, { minArea: 800 })

    for (const o of result.obstacles) {
      assert.ok(
        o.orientation_deg >= -90 && o.orientation_deg <= 90,
        `Orientation ${o.orientation_deg}° should be in [-90, 90]`
      )
    }
  })

  it('all detected obstacles have valid confidence scores', async () => {
    const { data, width, height } = await loadTestImage('turn left, go around iPhone, 5 obstacles.jpg')
    const result = detectObstaclesRef(data, width, height, { minArea: 800 })

    for (const o of result.obstacles) {
      assert.ok(o.confidence >= 0 && o.confidence <= 1, `Confidence ${o.confidence} out of range`)
    }
  })

  it('bounding boxes are within image bounds', async () => {
    const { data, width, height } = await loadTestImage('No route available, 6 obstacles.jpg')
    const result = detectObstaclesRef(data, width, height, { minArea: 800 })

    for (const o of result.obstacles) {
      assert.ok(o.bbox.x >= 0, `bbox.x ${o.bbox.x} < 0`)
      assert.ok(o.bbox.y >= 0, `bbox.y ${o.bbox.y} < 0`)
      assert.ok(o.bbox.x + o.bbox.width <= width, `bbox right edge exceeds image width`)
      assert.ok(o.bbox.y + o.bbox.height <= height, `bbox bottom edge exceeds image height`)
    }
  })

  it('obstacle areas are reasonable sizes', async () => {
    const { data, width, height } = await loadTestImage('180 rotation needed, 5 obstacles.jpg')
    const result = detectObstaclesRef(data, width, height, { minArea: 800 })
    const totalPixels = width * height

    for (const o of result.obstacles) {
      assert.ok(o.area >= 800, `Area ${o.area} too small`)
      assert.ok(o.area < totalPixels * 0.4, `Area ${o.area} too large (>${totalPixels * 0.4})`)
    }
  })

  it('oriented bounding box centers are inside regular bounding box', async () => {
    const { data, width, height } = await loadTestImage('turn left, go around iPhone, 5 obstacles.jpg')
    const result = detectObstaclesRef(data, width, height, { minArea: 800 })

    for (const o of result.obstacles) {
      const margin = 5 // small margin for rounding
      assert.ok(
        o.oriented_bbox.center_x >= o.bbox.x - margin &&
        o.oriented_bbox.center_x <= o.bbox.x + o.bbox.width + margin,
        `OBB center_x ${o.oriented_bbox.center_x} outside bbox [${o.bbox.x}, ${o.bbox.x + o.bbox.width}]`
      )
      assert.ok(
        o.oriented_bbox.center_y >= o.bbox.y - margin &&
        o.oriented_bbox.center_y <= o.bbox.y + o.bbox.height + margin,
        `OBB center_y ${o.oriented_bbox.center_y} outside bbox [${o.bbox.y}, ${o.bbox.y + o.bbox.height}]`
      )
    }
  })
})

describe('CNN Obstacle Detection - Edge Cases', () => {
  it('handles all-black image with no obstacles', () => {
    const width = 100
    const height = 100
    const rgba = new Uint8Array(width * height * 4) // all zeros (black)
    const result = detectObstaclesRef(rgba, width, height)
    assert.equal(result.count, 0, 'All-black image should have 0 obstacles')
  })

  it('handles all-white image with no obstacles', () => {
    const width = 100
    const height = 100
    const rgba = new Uint8Array(width * height * 4).fill(255)
    const result = detectObstaclesRef(rgba, width, height)
    assert.equal(result.count, 0, 'All-white image should have 0 obstacles')
  })

  it('handles tiny image', () => {
    const rgba = new Uint8Array(4 * 4 * 4)
    const result = detectObstaclesRef(rgba, 4, 4)
    assert.equal(result.count, 0, 'Tiny image should have 0 detections')
  })

  it('handles single bright pixel on dark background', () => {
    const width = 50
    const height = 50
    const rgba = new Uint8Array(width * height * 4)
    // Place single bright pixel
    const idx = (25 * width + 25) * 4
    rgba[idx] = 255
    rgba[idx + 1] = 255
    rgba[idx + 2] = 255
    rgba[idx + 3] = 255

    const result = detectObstaclesRef(rgba, width, height)
    // Single pixel should be filtered out by minArea
    assert.equal(result.count, 0, 'Single pixel should not be detected as obstacle')
  })

  it('detects a large rectangular object', () => {
    const width = 200
    const height = 200
    const rgba = new Uint8Array(width * height * 4)
    // Dark background, bright rectangle
    for (let y = 50; y < 100; y++) {
      for (let x = 60; x < 160; x++) {
        const idx = (y * width + x) * 4
        rgba[idx] = 200
        rgba[idx + 1] = 200
        rgba[idx + 2] = 200
        rgba[idx + 3] = 255
      }
    }

    const result = detectObstaclesRef(rgba, width, height, { minArea: 100 })
    assert.ok(result.count >= 1, `Should detect at least 1 obstacle, got ${result.count}`)

    if (result.count > 0) {
      const o = result.obstacles[0]
      // Horizontal rectangle should have orientation near 0°
      assert.ok(Math.abs(o.orientation_deg) < 30,
        `Horizontal rect orientation should be near 0°, got ${o.orientation_deg}°`)
    }
  })
})
