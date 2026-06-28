use crate::cnn;
use crate::geometry;
use crate::types::{Component, DetectionResult, Obstacle};

/// Minimum obstacle area in pixels (at pooled resolution).
const MIN_AREA: u32 = 1500;

/// Maximum obstacle area as a fraction of total image area.
const MAX_AREA_FRACTION: f32 = 0.40;

/// Connected-component labelling via iterative flood-fill.
///
/// Operates on a binary mask where values > 0.5 are foreground.
/// Returns a label map and a list of components.
fn connected_components(mask: &[f32], width: usize, height: usize) -> Vec<Component> {
    let total = width * height;
    let mut labels = vec![0u32; total];
    let mut components: Vec<Component> = Vec::new();
    let mut current_label: u32 = 0;

    for start in 0..total {
        if mask[start] < 0.5 || labels[start] != 0 {
            continue;
        }

        current_label += 1;
        let mut comp = Component::new(current_label);
        let mut stack = vec![start];

        while let Some(idx) = stack.pop() {
            if labels[idx] != 0 {
                continue;
            }
            if mask[idx] < 0.5 {
                continue;
            }

            labels[idx] = current_label;
            let x = (idx % width) as u32;
            let y = (idx / width) as u32;
            comp.add_pixel(x, y);

            // 4-connected neighbours
            if x > 0 {
                let ni = idx - 1;
                if labels[ni] == 0 {
                    stack.push(ni);
                }
            }
            if (x as usize) < width - 1 {
                let ni = idx + 1;
                if labels[ni] == 0 {
                    stack.push(ni);
                }
            }
            if y > 0 {
                let ni = idx - width;
                if labels[ni] == 0 {
                    stack.push(ni);
                }
            }
            if (y as usize) < height - 1 {
                let ni = idx + width;
                if labels[ni] == 0 {
                    stack.push(ni);
                }
            }
        }

        components.push(comp);
    }

    components
}

/// Compute a confidence score based on edge strength within the component
/// relative to the surrounding region.
fn compute_confidence(
    gray: &[f32],
    pixels: &[(u32, u32)],
    width: usize,
    height: usize,
    pool_scale: usize,
) -> f32 {
    if pixels.is_empty() {
        return 0.0;
    }

    // Mean intensity of the component (mapped back to full-res coordinates).
    let mut obj_sum = 0.0f64;
    let mut obj_count = 0u64;
    for &(px, py) in pixels {
        let fx = (px as usize * pool_scale).min(width - 1);
        let fy = (py as usize * pool_scale).min(height - 1);
        obj_sum += gray[fy * width + fx] as f64;
        obj_count += 1;
    }
    let obj_mean = obj_sum / obj_count as f64;

    // Global mean intensity of the whole image.
    let global_mean: f64 = gray.iter().map(|&v| v as f64).sum::<f64>() / gray.len() as f64;

    // Confidence = contrast ratio between object and background.
    let contrast = (obj_mean - global_mean).abs();
    // Normalise to [0, 1] — a contrast of 0.5 or more is very strong.
    (contrast as f32 * 2.0).clamp(0.0, 1.0)
}

/// Determine whether a component is likely the USB dongle / cable region
/// that should be filtered out (top-center of the image).
fn is_infrastructure(comp: &Component, img_width: u32, img_height: u32) -> bool {
    let bbox = comp.bbox();
    let center_x = bbox.x + bbox.width / 2;
    let img_cx = img_width / 2;

    // Must be in the top 12% of the image
    let top_threshold = img_height / 8;
    let is_top = bbox.y < top_threshold;

    // Must be horizontally centered (within middle 40%)
    let margin = img_width / 5;
    let is_centered = center_x > (img_cx - margin) && center_x < (img_cx + margin);

    is_top && is_centered
}

/// Run the full detection pipeline on an RGBA image.
///
/// Returns a `DetectionResult` with all detected obstacles.
pub fn detect(rgba: &[u8], width: u32, height: u32) -> DetectionResult {
    let w = width as usize;
    let h = height as usize;

    // ── Step 1: Grayscale conversion ─────────────────────────────
    let gray = cnn::rgba_to_grayscale(rgba, w, h);

    // ── Step 2: CNN pipeline → binary mask at half resolution ────
    let (mask, pooled_w, pooled_h) = cnn::run_pipeline(&gray, w, h);
    let pool_scale: usize = 2; // due to 2×2 max pooling

    // ── Step 3: Connected component analysis ─────────────────────
    let components = connected_components(&mask, pooled_w, pooled_h);

    let total_pooled_area = (pooled_w * pooled_h) as f32;
    let max_area = (total_pooled_area * MAX_AREA_FRACTION) as u32;

    // Scaled image dims for infrastructure check
    let scaled_w = pooled_w as u32;
    let scaled_h = pooled_h as u32;

    // ── Step 4: Filter + extract obstacles ───────────────────────
    let mut obstacles: Vec<Obstacle> = Vec::new();

    for comp in &components {
        let area = comp.area();

        // Size filters
        if area < MIN_AREA || area > max_area {
            continue;
        }

        // Infrastructure filter (USB dongle/cable)
        if is_infrastructure(comp, scaled_w, scaled_h) {
            continue;
        }

        // Geometry
        let (obb, orientation) = geometry::compute_oriented_bbox(&comp.pixels);

        // Scale bounding box back to original resolution
        let raw_bbox = comp.bbox();
        let bbox = crate::types::BBox {
            x: raw_bbox.x * pool_scale as u32,
            y: raw_bbox.y * pool_scale as u32,
            width: raw_bbox.width * pool_scale as u32,
            height: raw_bbox.height * pool_scale as u32,
        };

        let scaled_obb = crate::types::OrientedBBox {
            center_x: obb.center_x * pool_scale as f32,
            center_y: obb.center_y * pool_scale as f32,
            width: obb.width * pool_scale as f32,
            height: obb.height * pool_scale as f32,
            angle: obb.angle,
        };

        let confidence = compute_confidence(&gray, &comp.pixels, w, h, pool_scale);

        let obstacle = Obstacle {
            id: obstacles.len() as u32,
            bbox,
            oriented_bbox: scaled_obb,
            area: area * (pool_scale * pool_scale) as u32,
            orientation_deg: orientation,
            confidence,
        };
        obstacles.push(obstacle);
    }

    // We preserve the natural order from connected_components, which scans top-left to bottom-right.
    // This provides much more stable object IDs between frames than sorting by noisy area measurements.

    let count = obstacles.len();
    DetectionResult {
        obstacles,
        count,
        processing_time_ms: 0.0, // filled in by the caller
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_connected_components_two_blobs() {
        // 6×6 grid with two separate blobs
        #[rustfmt::skip]
        let mask: Vec<f32> = vec![
            1.0, 1.0, 0.0, 0.0, 0.0, 0.0,
            1.0, 1.0, 0.0, 0.0, 0.0, 0.0,
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
            0.0, 0.0, 0.0, 0.0, 1.0, 1.0,
            0.0, 0.0, 0.0, 0.0, 1.0, 1.0,
            0.0, 0.0, 0.0, 0.0, 1.0, 1.0,
        ];
        let components = connected_components(&mask, 6, 6);
        assert_eq!(components.len(), 2);
        assert_eq!(components[0].area(), 4);
        assert_eq!(components[1].area(), 6);
    }

    #[test]
    fn test_empty_image_no_detections() {
        // All-black image → no obstacles
        let w = 64u32;
        let h = 64u32;
        let rgba = vec![0u8; (w * h * 4) as usize];
        let result = detect(&rgba, w, h);
        assert_eq!(result.count, 0);
    }

    #[test]
    fn test_infrastructure_filter() {
        let mut comp = Component::new(1);
        // Place component in top-center
        for x in 40..60 {
            for y in 0..5 {
                comp.add_pixel(x, y);
            }
        }
        assert!(is_infrastructure(&comp, 100, 100));

        // Place component in the middle — should not be filtered
        let mut comp2 = Component::new(2);
        for x in 40..60 {
            for y in 40..60 {
                comp2.add_pixel(x, y);
            }
        }
        assert!(!is_infrastructure(&comp2, 100, 100));
    }
}
