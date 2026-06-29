use crate::types::OrientedBBox;

/// Compute the oriented bounding box and principal axis of a set of pixel coordinates
/// using image moments (equivalent to PCA on the 2D point cloud).
///
/// Returns `(oriented_bbox, orientation_degrees)`.
pub fn compute_oriented_bbox(pixels: &[(u32, u32)]) -> (OrientedBBox, f32) {
    let n = pixels.len() as f64;
    if n == 0.0 {
        return (
            OrientedBBox {
                center_x: 0.0,
                center_y: 0.0,
                width: 0.0,
                height: 0.0,
                angle: 0.0,
            },
            0.0,
        );
    }

    // ── Centroid ──────────────────────────────────────────────────
    let (sum_x, sum_y) = pixels.iter().fold((0.0f64, 0.0f64), |(sx, sy), &(px, py)| {
        (sx + px as f64, sy + py as f64)
    });
    let cx = sum_x / n;
    let cy = sum_y / n;

    // ── Second-order central moments ─────────────────────────────
    let (mut mu20, mut mu02, mut mu11) = (0.0f64, 0.0f64, 0.0f64);
    for &(px, py) in pixels {
        let dx = px as f64 - cx;
        let dy = py as f64 - cy;
        mu20 += dx * dx;
        mu02 += dy * dy;
        mu11 += dx * dy;
    }
    mu20 /= n;
    mu02 /= n;
    mu11 /= n;

    // ── Principal axis angle via PCA ─────────────────────────────
    // theta = 0.5 * atan2(2 * mu11, mu20 - mu02)
    let theta = 0.5 * (2.0 * mu11).atan2(mu20 - mu02);

    let cos_t = theta.cos();
    let sin_t = theta.sin();

    // ── Project all pixels onto the principal axes ────────────────
    let mut min_u = f64::MAX;
    let mut max_u = f64::MIN;
    let mut min_v = f64::MAX;
    let mut max_v = f64::MIN;

    for &(px, py) in pixels {
        let dx = px as f64 - cx;
        let dy = py as f64 - cy;
        let u = dx * cos_t + dy * sin_t;
        let v = -dx * sin_t + dy * cos_t;
        min_u = min_u.min(u);
        max_u = max_u.max(u);
        min_v = min_v.min(v);
        max_v = max_v.max(v);
    }

    let u_len = max_u - min_u;
    let v_len = max_v - min_v;

    // width is the dimension along the principal axis, height is perpendicular
    let obb = OrientedBBox {
        center_x: cx as f32,
        center_y: cy as f32,
        width: u_len as f32,
        height: v_len as f32,
        angle: theta.to_degrees() as f32,
    };

    (obb, theta.to_degrees() as f32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_horizontal_strip() {
        // A horizontal strip of pixels → angle ≈ 0°
        let pixels: Vec<(u32, u32)> = (0..100).map(|x| (x, 50)).collect();
        let (obb, angle) = compute_oriented_bbox(&pixels);
        assert!(angle.abs() < 5.0, "Expected ~0° for horizontal strip, got {angle}");
        assert!(obb.width > obb.height);
    }

    #[test]
    fn test_vertical_strip() {
        // A vertical strip → angle ≈ ±90°
        let pixels: Vec<(u32, u32)> = (0..100).map(|y| (50, y)).collect();
        let (_obb, angle) = compute_oriented_bbox(&pixels);
        assert!(
            (angle.abs() - 90.0).abs() < 5.0,
            "Expected ~±90° for vertical strip, got {angle}"
        );
    }

    #[test]
    fn test_diagonal_strip() {
        // 45° diagonal strip
        let pixels: Vec<(u32, u32)> = (0..100).map(|i| (i, i)).collect();
        let (_obb, angle) = compute_oriented_bbox(&pixels);
        assert!(
            (angle - 45.0).abs() < 5.0,
            "Expected ~45° for diagonal strip, got {angle}"
        );
    }

    #[test]
    fn test_empty_pixels() {
        let (obb, angle) = compute_oriented_bbox(&[]);
        assert_eq!(angle, 0.0);
        assert_eq!(obb.center_x, 0.0);
    }
}
