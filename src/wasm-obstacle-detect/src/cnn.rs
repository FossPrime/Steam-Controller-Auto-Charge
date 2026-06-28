/// CNN-like pipeline using hardcoded classical CV kernels.
///
/// The pipeline applies a sequence of convolutions, pooling, and thresholding
/// to produce a binary foreground mask from raw grayscale input.

/// Apply a 2D convolution with the given kernel on a single-channel f32 image.
/// Returns a new buffer of the same dimensions (zero-padded at borders).
fn convolve(
    input: &[f32],
    width: usize,
    height: usize,
    kernel: &[f32],
    k_size: usize,
) -> Vec<f32> {
    let half = (k_size / 2) as isize;
    let mut output = vec![0.0f32; width * height];

    for y in 0..height {
        for x in 0..width {
            let mut sum = 0.0f32;
            for ky in 0..k_size {
                for kx in 0..k_size {
                    let sy = y as isize + ky as isize - half;
                    let sx = x as isize + kx as isize - half;
                    if sy >= 0 && sy < height as isize && sx >= 0 && sx < width as isize {
                        sum += input[sy as usize * width + sx as usize]
                            * kernel[ky * k_size + kx];
                    }
                }
            }
            output[y * width + x] = sum;
        }
    }
    output
}

/// ReLU activation: clamp negative values to zero.
fn relu(data: &mut [f32]) {
    for v in data.iter_mut() {
        if *v < 0.0 {
            *v = 0.0;
        }
    }
}

/// 2×2 max pooling — halves both spatial dimensions.
fn max_pool_2x2(input: &[f32], width: usize, height: usize) -> (Vec<f32>, usize, usize) {
    let out_w = width / 2;
    let out_h = height / 2;
    let mut output = vec![0.0f32; out_w * out_h];

    for y in 0..out_h {
        for x in 0..out_w {
            let sy = y * 2;
            let sx = x * 2;
            let a = input[sy * width + sx];
            let b = input[sy * width + sx + 1];
            let c = input[(sy + 1) * width + sx];
            let d = input[(sy + 1) * width + sx + 1];
            output[y * out_w + x] = a.max(b).max(c).max(d);
        }
    }
    (output, out_w, out_h)
}

/// Otsu-like adaptive threshold.
/// Computes the optimal threshold that minimises intra-class variance,
/// then returns a binary mask (1.0 = foreground, 0.0 = background).
fn otsu_threshold(data: &[f32], len: usize) -> (Vec<f32>, f32) {
    // Build a 256-bin histogram of the data normalised to [0, 255].
    let (min_val, max_val) = data.iter().fold((f32::MAX, f32::MIN), |(lo, hi), &v| {
        (lo.min(v), hi.max(v))
    });
    let range = (max_val - min_val).max(1e-6);

    let mut histogram = [0u32; 256];
    for &v in data.iter() {
        let bin = (((v - min_val) / range) * 255.0) as usize;
        histogram[bin.min(255)] += 1;
    }

    let total = len as f64;
    let mut sum_total: f64 = 0.0;
    for (i, &count) in histogram.iter().enumerate() {
        sum_total += i as f64 * count as f64;
    }

    let mut sum_bg: f64 = 0.0;
    let mut weight_bg: f64 = 0.0;
    let mut best_thresh: usize = 0;
    let mut best_variance: f64 = 0.0;

    for (t, &count) in histogram.iter().enumerate() {
        weight_bg += count as f64;
        if weight_bg == 0.0 {
            continue;
        }
        let weight_fg = total - weight_bg;
        if weight_fg == 0.0 {
            break;
        }
        sum_bg += t as f64 * count as f64;
        let mean_bg = sum_bg / weight_bg;
        let mean_fg = (sum_total - sum_bg) / weight_fg;
        let variance = weight_bg * weight_fg * (mean_bg - mean_fg).powi(2);
        if variance > best_variance {
            best_variance = variance;
            best_thresh = t;
        }
    }

    // Use the midpoint between the threshold bin and the next bin for cleaner separation
    let threshold_val = min_val + ((best_thresh as f32 + 0.5) / 255.0) * range;
    let mask: Vec<f32> = data.iter().map(|&v| if v > threshold_val { 1.0 } else { 0.0 }).collect();
    (mask, threshold_val)
}

/// Convert RGBA u8 pixel data to grayscale f32 in [0, 1].
pub fn rgba_to_grayscale(rgba: &[u8], width: usize, height: usize) -> Vec<f32> {
    let pixel_count = width * height;
    let mut gray = Vec::with_capacity(pixel_count);
    for i in 0..pixel_count {
        let r = rgba[i * 4] as f32;
        let g = rgba[i * 4 + 1] as f32;
        let b = rgba[i * 4 + 2] as f32;
        // ITU-R BT.601 luminance
        gray.push((0.299 * r + 0.587 * g + 0.114 * b) / 255.0);
    }
    gray
}

/// Run the full CNN-like pipeline and return a binary foreground mask
/// at half resolution (due to pooling) plus the pooled dimensions.
pub fn run_pipeline(
    gray: &[f32],
    width: usize,
    height: usize,
) -> (Vec<f32>, usize, usize) {
    // ── Layer 0: Gaussian blur (3×3) ─────────────────────────────
    #[rustfmt::skip]
    let gaussian_3x3: [f32; 9] = [
        1.0/16.0, 2.0/16.0, 1.0/16.0,
        2.0/16.0, 4.0/16.0, 2.0/16.0,
        1.0/16.0, 2.0/16.0, 1.0/16.0,
    ];
    let blurred = convolve(gray, width, height, &gaussian_3x3, 3);

    // ── Layer 1: Sobel edge detection (3×3), ReLU ────────────────
    #[rustfmt::skip]
    let sobel_h: [f32; 9] = [
        -1.0, 0.0, 1.0,
        -2.0, 0.0, 2.0,
        -1.0, 0.0, 1.0,
    ];
    #[rustfmt::skip]
    let sobel_v: [f32; 9] = [
        -1.0, -2.0, -1.0,
         0.0,  0.0,  0.0,
         1.0,  2.0,  1.0,
    ];
    let mut edge_h = convolve(&blurred, width, height, &sobel_h, 3);
    let mut edge_v = convolve(&blurred, width, height, &sobel_v, 3);
    relu(&mut edge_h);
    relu(&mut edge_v);

    // Edge magnitude (L2)
    let edge_mag: Vec<f32> = edge_h
        .iter()
        .zip(edge_v.iter())
        .map(|(&h, &v)| (h * h + v * v).sqrt())
        .collect();

    // ── Layer 2: Laplacian-of-Gaussian blob detection (5×5), ReLU ─
    #[rustfmt::skip]
    let log_5x5: [f32; 25] = [
         0.0,  0.0, -1.0,  0.0,  0.0,
         0.0, -1.0, -2.0, -1.0,  0.0,
        -1.0, -2.0, 16.0, -2.0, -1.0,
         0.0, -1.0, -2.0, -1.0,  0.0,
         0.0,  0.0, -1.0,  0.0,  0.0,
    ];
    let mut blob = convolve(&blurred, width, height, &log_5x5, 5);
    relu(&mut blob);

    // ── Layer 3: 2×2 max pooling on all feature maps ─────────────
    let (edge_pooled, pw, ph) = max_pool_2x2(&edge_mag, width, height);
    let (blob_pooled, _, _) = max_pool_2x2(&blob, width, height);
    let (brightness_pooled, _, _) = max_pool_2x2(&blurred, width, height);

    // ── Layer 4: Feature combination ─────────────────────────────
    // Normalise each feature map to [0, 1] then combine.
    // Include raw brightness to help detect filled bright objects on dark desks.
    let edge_max = edge_pooled.iter().cloned().fold(0.0f32, f32::max).max(1e-6);
    let blob_max = blob_pooled.iter().cloned().fold(0.0f32, f32::max).max(1e-6);
    let bright_max = brightness_pooled.iter().cloned().fold(0.0f32, f32::max).max(1e-6);

    let combined: Vec<f32> = edge_pooled
        .iter()
        .zip(blob_pooled.iter())
        .zip(brightness_pooled.iter())
        .map(|((&e, &b), &br)| {
            0.4 * (e / edge_max) + 0.25 * (b / blob_max) + 0.35 * (br / bright_max)
        })
        .collect();

    // ── Layer 5: Adaptive threshold (Otsu) ───────────────────────
    let (mask, _thresh) = otsu_threshold(&combined, pw * ph);

    // ── Layer 6: Morphological cleanup ───────────────────────────
    // Larger dilation to bridge gaps between edge and interior pixels,
    // followed by erosion to restore object boundaries.
    let dilated = dilate(&mask, pw, ph, 7);
    let cleaned = erode(&dilated, pw, ph, 5);

    (cleaned, pw, ph)
}

// ── Morphological helpers ────────────────────────────────────────────

fn dilate(mask: &[f32], width: usize, height: usize, k_size: usize) -> Vec<f32> {
    let half = (k_size / 2) as isize;
    let mut out = vec![0.0f32; width * height];
    for y in 0..height {
        for x in 0..width {
            let mut found = false;
            'outer: for ky in 0..k_size {
                for kx in 0..k_size {
                    let sy = y as isize + ky as isize - half;
                    let sx = x as isize + kx as isize - half;
                    if sy >= 0
                        && sy < height as isize
                        && sx >= 0
                        && sx < width as isize
                        && mask[sy as usize * width + sx as usize] > 0.5
                    {
                        found = true;
                        break 'outer;
                    }
                }
            }
            out[y * width + x] = if found { 1.0 } else { 0.0 };
        }
    }
    out
}

fn erode(mask: &[f32], width: usize, height: usize, k_size: usize) -> Vec<f32> {
    let half = (k_size / 2) as isize;
    let mut out = vec![0.0f32; width * height];
    for y in 0..height {
        for x in 0..width {
            let mut all = true;
            'outer: for ky in 0..k_size {
                for kx in 0..k_size {
                    let sy = y as isize + ky as isize - half;
                    let sx = x as isize + kx as isize - half;
                    if sy < 0
                        || sy >= height as isize
                        || sx < 0
                        || sx >= width as isize
                        || mask[sy as usize * width + sx as usize] < 0.5
                    {
                        all = false;
                        break 'outer;
                    }
                }
            }
            out[y * width + x] = if all { 1.0 } else { 0.0 };
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_relu_zeroes_negatives() {
        let mut data = vec![-1.0, 0.0, 1.0, -0.5, 3.0];
        relu(&mut data);
        assert_eq!(data, vec![0.0, 0.0, 1.0, 0.0, 3.0]);
    }

    #[test]
    fn test_convolve_identity() {
        // Identity kernel should leave the image unchanged (interior pixels).
        let kernel = [0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0];
        let input = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0];
        let out = convolve(&input, 3, 3, &kernel, 3);
        assert_eq!(out, input);
    }

    #[test]
    fn test_max_pool_2x2_basic() {
        let input = vec![1.0, 3.0, 2.0, 4.0, 5.0, 7.0, 6.0, 8.0, 9.0, 11.0, 10.0, 12.0, 13.0, 15.0, 14.0, 16.0];
        let (out, w, h) = max_pool_2x2(&input, 4, 4);
        assert_eq!(w, 2);
        assert_eq!(h, 2);
        assert_eq!(out, vec![7.0, 8.0, 15.0, 16.0]);
    }

    #[test]
    fn test_otsu_bimodal() {
        // Two distinct clusters → threshold should separate them.
        let mut data = vec![0.0f32; 100];
        for i in 50..100 {
            data[i] = 1.0;
        }
        let (mask, _thresh) = otsu_threshold(&data, 100);
        // First 50 should be 0, last 50 should be 1
        assert!(mask[0] < 0.5);
        assert!(mask[99] > 0.5);
    }

    #[test]
    fn test_grayscale_conversion() {
        // Pure white pixel → 1.0
        let rgba = [255u8, 255, 255, 255];
        let gray = rgba_to_grayscale(&rgba, 1, 1);
        assert!((gray[0] - 1.0).abs() < 0.01);
    }
}
