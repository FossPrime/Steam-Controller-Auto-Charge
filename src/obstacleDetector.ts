/**
 * obstacleDetector.ts - TypeScript integration layer for the Rust WASM CNN obstacle detector.
 *
 * This module loads the WASM binary, feeds camera frames to the CNN pipeline,
 * and renders oriented bounding boxes with orientation arrows on a canvas.
 *
 * The CNN runs entirely in the browser — no API calls, no network requests.
 */

// --- Types matching the Rust WASM output ---

export interface BoundingBox {
  x: number
  y: number
  width: number
  height: number
}

export interface OrientedBoundingBox {
  center_x: number
  center_y: number
  width: number
  height: number
  /** Orientation angle in degrees (0° = right, 90° = up) */
  angle: number
}

export interface Obstacle {
  id: number
  bbox: BoundingBox
  oriented_bbox: OrientedBoundingBox
  area: number
  /** Principal axis orientation in degrees */
  orientation_deg: number
  /** Detection confidence 0.0 – 1.0 */
  confidence: number
}

export interface DetectionResult {
  obstacles: Obstacle[]
  count: number
  processing_time_ms: number
}

// --- Color palette for bounding boxes (vibrant, high-contrast on dark desk) ---
const BOX_COLORS = [
  '#00f0ff', // cyan
  '#ff3d71', // hot pink
  '#00e676', // green
  '#ffab40', // orange
  '#7c4dff', // purple
  '#ffd740', // gold
  '#18ffff', // light cyan
  '#ff6e40', // deep orange
  '#69f0ae', // light green
  '#e040fb', // magenta
] as const

/**
 * Manages the lifecycle of the Rust WASM obstacle detection CNN.
 * Handles loading, frame processing, and canvas rendering.
 */
export class ObstacleDetector {
  private worker: Worker | null = null
  private isReady = false
  private lastResult: DetectionResult | null = null
  private isProcessing = false
  private objectTracks: Map<number, Obstacle> = new Map()
  private nextTrackId = 0

  /** Whether the Web Worker has been loaded and initialized */
  get ready(): boolean {
    return this.isReady
  }

  /** The most recent detection result */
  get result(): DetectionResult | null {
    return this.lastResult
  }

  /**
   * Initialize the WASM module inside a Web Worker.
   * Must be called once before any detection calls.
   */
  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.worker = new Worker(new URL('./obstacleWorker.ts', import.meta.url), { type: 'module' })
      
      this.worker.onmessage = (e) => {
        const { type, payload, error } = e.data
        if (type === 'ready') {
          this.isReady = true
          console.log('[ObstacleDetector] Worker loaded and ready')
          resolve()
        } else if (type === 'result') {
          this.processResultWithSmoothing(payload.result)
          this.isProcessing = false
        } else if (type === 'error') {
          console.error('[ObstacleDetector] Worker Error:', error)
          this.isProcessing = false
          if (!this.isReady) reject(new Error(error))
        }
      }

      this.worker.onerror = (err) => {
        console.error('[ObstacleDetector] Worker Error:', err)
        this.isProcessing = false
        if (!this.isReady) reject(err)
      }

      this.worker.postMessage({ type: 'init' })
    })
  }

  /**
   * Run the CNN obstacle detection pipeline asynchronously.
   * The result will be available in `this.result` when completed.
   */
  detect(rgbaData: Uint8ClampedArray | Uint8Array, width: number, height: number): void {
    if (!this.worker || !this.isReady) {
      throw new Error('ObstacleDetector not initialized — call init() first')
    }
    
    if (this.isProcessing) return; // Drop frame if still processing

    this.isProcessing = true
    // Copy the buffer so it can be transferred without detaching the canvas backing store
    const buffer = rgbaData.buffer.slice(0)
    
    this.worker.postMessage({
      type: 'detect',
      payload: {
        rgbaData: buffer,
        width,
        height,
        id: Date.now()
      }
    }, [buffer]) // transfer the cloned buffer for performance
  }

  /**
   * Smooths incoming detections using distance-based tracking and EMA.
   */
  private processResultWithSmoothing(newResult: DetectionResult): void {
    const newTracks: Map<number, Obstacle> = new Map()
    const alpha = 0.6 // EMA smoothing factor (0.0 to 1.0)
    
    for (const obs of newResult.obstacles) {
      let bestId = -1
      let minDistance = 5000 // roughly 70px radius
      
      for (const [trackId, oldObs] of this.objectTracks.entries()) {
        const dx = oldObs.bbox.x - obs.bbox.x
        const dy = oldObs.bbox.y - obs.bbox.y
        const dist = dx * dx + dy * dy
        if (dist < minDistance) {
          bestId = trackId
          minDistance = dist
        }
      }
      
      let stableId = bestId
      if (stableId === -1) {
        stableId = this.nextTrackId++
      } else {
        this.objectTracks.delete(stableId) // consumed
      }
      
      obs.id = stableId
      
      if (bestId !== -1) {
        const old = this.objectTracks.get(stableId) || obs // fallback for TS
        
        // EMA on AABB
        obs.bbox.x = old.bbox.x * (1 - alpha) + obs.bbox.x * alpha
        obs.bbox.y = old.bbox.y * (1 - alpha) + obs.bbox.y * alpha
        obs.bbox.width = old.bbox.width * (1 - alpha) + obs.bbox.width * alpha
        obs.bbox.height = old.bbox.height * (1 - alpha) + obs.bbox.height * alpha
        
        // EMA on OBB
        const obb = obs.oriented_bbox
        const o_obb = old.oriented_bbox
        obb.center_x = o_obb.center_x * (1 - alpha) + obb.center_x * alpha
        obb.center_y = o_obb.center_y * (1 - alpha) + obb.center_y * alpha
        obb.width = o_obb.width * (1 - alpha) + obb.width * alpha
        obb.height = o_obb.height * (1 - alpha) + obb.height * alpha
        
        // Smooth angle (avoiding wrap-around issues by smoothing the vector)
        const oldRad = o_obb.angle * Math.PI / 180
        const newRad = obb.angle * Math.PI / 180
        const vx = Math.cos(oldRad) * (1 - alpha) + Math.cos(newRad) * alpha
        const vy = Math.sin(oldRad) * (1 - alpha) + Math.sin(newRad) * alpha
        obb.angle = Math.atan2(vy, vx) * 180 / Math.PI
      }
      
      newTracks.set(stableId, obs)
    }
    
    this.objectTracks = newTracks
    this.lastResult = newResult
  }

  /**
   * Run detection on a canvas element's current content asynchronously.
   * Convenience wrapper that extracts pixel data from the canvas.
   */
  detectFromCanvas(canvas: HTMLCanvasElement): void {
    if (this.isProcessing) return;
    
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('Cannot get 2d context from canvas')

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    this.detect(imageData.data, canvas.width, canvas.height)
  }

  /**
   * Draw all detected obstacle bounding boxes onto a canvas.
   *
   * Renders:
   * - Oriented bounding box (rotated rectangle) with color-coded stroke
   * - Axis-aligned bounding box (dashed) for reference
   * - Orientation arrow showing the principal axis direction
   * - Obstacle ID label with confidence percentage
   *
   * @param ctx - Canvas 2D rendering context
   * @param result - Detection result to render (defaults to last result)
   */
  drawDetections(ctx: CanvasRenderingContext2D, result?: DetectionResult): void {
    const data = result ?? this.lastResult
    if (!data) return

    for (const obstacle of data.obstacles) {
      const color = BOX_COLORS[obstacle.id % BOX_COLORS.length]

      // --- Draw axis-aligned bounding box (dashed) ---
      ctx.save()
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.setLineDash([6, 4])
      ctx.globalAlpha = 0.5
      ctx.strokeRect(
        obstacle.bbox.x,
        obstacle.bbox.y,
        obstacle.bbox.width,
        obstacle.bbox.height
      )
      ctx.restore()

      // --- Draw oriented bounding box (solid, rotated) ---
      const obb = obstacle.oriented_bbox
      const angleRad = (obb.angle * Math.PI) / 180

      ctx.save()
      ctx.translate(obb.center_x, obb.center_y)
      ctx.rotate(angleRad) // PCA uses the same Y-down coordinate space as Canvas

      // Filled background with low opacity
      ctx.fillStyle = color
      ctx.globalAlpha = 0.08
      ctx.fillRect(-obb.width / 2, -obb.height / 2, obb.width, obb.height)

      // Solid border
      ctx.globalAlpha = 0.9
      ctx.strokeStyle = color
      ctx.lineWidth = 2.5
      ctx.setLineDash([])
      ctx.strokeRect(-obb.width / 2, -obb.height / 2, obb.width, obb.height)
      ctx.restore()



      // --- Draw label ---
      const labelText = `#${obstacle.id} (${Math.round(obstacle.confidence * 100)}%)`
      const labelX = obstacle.bbox.x
      const labelY = obstacle.bbox.y - 6

      ctx.save()
      ctx.font = 'bold 13px Inter, system-ui, sans-serif'
      const metrics = ctx.measureText(labelText)
      const labelPad = 4

      // Label background
      ctx.fillStyle = color
      ctx.globalAlpha = 0.85
      ctx.fillRect(
        labelX - labelPad,
        labelY - 14,
        metrics.width + labelPad * 2,
        18
      )

      // Label text
      ctx.fillStyle = '#000'
      ctx.globalAlpha = 1
      ctx.fillText(labelText, labelX, labelY)
      ctx.restore()
    }

    // --- Draw summary ---
    ctx.save()
    ctx.font = 'bold 14px Inter, system-ui, sans-serif'
    ctx.fillStyle = '#00f0ff'
    ctx.globalAlpha = 0.9
    const summary = `${data.count} obstacle${data.count !== 1 ? 's' : ''} detected (${data.processing_time_ms.toFixed(1)}ms)`
    ctx.fillText(summary, 12, 24)
    ctx.restore()
  }
}


