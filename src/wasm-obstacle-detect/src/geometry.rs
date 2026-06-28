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
    let u_asym = max_u + min_u; // positive if bounding box extends more in +u
    let v_asym = max_v + min_v; // positive if bounding box extends more in +v

    // ── Pixel Mass Asymmetry (for 180-deg ambiguity) ──────────────
    // The centroid balances the moments, but the 'fat' side of an object 
    // will always have a larger raw pixel count than the 'thin' side.
    let mut u_mass_pos = 0;
    let mut u_mass_neg = 0;
    let mut v_mass_pos = 0;
    let mut v_mass_neg = 0;

    for &(px, py) in pixels {
        let dx = px as f64 - cx;
        let dy = py as f64 - cy;
        let u = dx * cos_t + dy * sin_t;
        let v = -dx * sin_t + dy * cos_t;
        
        if u > 0.0 { u_mass_pos += 1; } else { u_mass_neg += 1; }
        if v > 0.0 { v_mass_pos += 1; } else { v_mass_neg += 1; }
    }

    let mut forward_u = 1.0;
    let mut forward_v = 0.0;
    let mut swap_axes = false;

    // Use aspect ratio to determine if the object is functionally "wider than it is tall"
    let aspect_ratio = u_len / v_len;

    if aspect_ratio < 1.6 {
        swap_axes = true;
        // Controller: Top is a solid fat block, bottom has a gap between grips.
        // So the front (top) is the FAT side (has more pixels).
        // If v_mass_pos > v_mass_neg, then +v is the front!
        forward_v = if v_mass_pos > v_mass_neg { 1.0 } else { -1.0 };
        forward_u = 0.0;
    } else {
        // Phone/Mouse/Remote: Back is usually heavier (mouse) or it's symmetrical (phone).
        // If u_mass_pos > u_mass_neg, then +u is the fat side. Front is opposite (-u).
        forward_u = if u_mass_pos > u_mass_neg { -1.0 } else { 1.0 };
    }

    // Calculate the final angle based on the chosen forward vector.
    // Base axes in image space: u_vec = (cos_t, sin_t), v_vec = (-sin_t, cos_t)
    let final_vec_x = forward_u * cos_t + forward_v * -sin_t;
    let final_vec_y = forward_u * sin_t + forward_v * cos_t;
    
    let angle_deg = final_vec_y.atan2(final_vec_x).to_degrees() as f32;

    // width is the dimension along the forward axis, height is perpendicular
    let obb_width = if swap_axes { v_len as f32 } else { u_len as f32 };
    let obb_height = if swap_axes { u_len as f32 } else { v_len as f32 };

    let obb = OrientedBBox {
        center_x: cx as f32,
        center_y: cy as f32,
        width: obb_width,
        height: obb_height,
        angle: angle_deg,
    };

    (obb, angle_deg)
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
