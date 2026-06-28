//! # obstacle-detect
//!
//! A lightweight CNN-based obstacle detection pipeline compiled to WebAssembly.
//! Uses hardcoded classical computer-vision kernels (Sobel, LoG, Gaussian)
//! arranged in a CNN-like sequential architecture — no training data needed.
//!
//! Designed for the Steam Controller Auto-Charge project: an overhead camera
//! watches a desk and this module identifies obstacles that the controller
//! must navigate around to reach its charging puck.

mod cnn;
mod detection;
mod geometry;
mod types;

use wasm_bindgen::prelude::*;

/// Run obstacle detection on raw RGBA pixel data.
///
/// # Arguments
/// * `rgba_data` — Flat `[u8]` of RGBA pixels (length = width × height × 4).
/// * `width`     — Image width in pixels.
/// * `height`    — Image height in pixels.
///
/// # Returns
/// A JSON string containing the detection results.
#[wasm_bindgen]
pub fn detect_obstacles(rgba_data: &[u8], width: u32, height: u32) -> String {
    let expected_len = (width as usize) * (height as usize) * 4;
    if rgba_data.len() != expected_len {
        return serde_json::to_string(&types::DetectionResult {
            obstacles: vec![],
            count: 0,
            processing_time_ms: 0.0,
        })
        .unwrap_or_default();
    }

    // Use web_sys performance timing when available, fall back to 0.
    let start = now_ms();

    let mut result = detection::detect(rgba_data, width, height);

    let elapsed = now_ms() - start;
    result.processing_time_ms = elapsed;

    #[cfg(target_arch = "wasm32")]
    {
        // Removed console.log spam
    }

    serde_json::to_string(&result).unwrap_or_default()
}

/// Return the crate version string.
#[wasm_bindgen]
pub fn version() -> String {
    format!(
        "{} v{}",
        env!("CARGO_PKG_NAME"),
        env!("CARGO_PKG_VERSION")
    )
}

// ── Timing helper ────────────────────────────────────────────────────

/// Get current time in milliseconds.
/// On wasm32 this uses `performance.now()`, on native it's a no-op returning 0.
#[cfg(target_arch = "wasm32")]
fn now_ms() -> f64 {
    js_sys::Date::now()
}

#[cfg(not(target_arch = "wasm32"))]
fn now_ms() -> f64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version_string() {
        let v = version();
        assert!(v.contains("obstacle-detect"));
        assert!(v.contains("0.1.0"));
    }

    #[test]
    fn test_detect_obstacles_wrong_size() {
        // Wrong buffer size → should return empty result, not panic.
        let result = detect_obstacles(&[0u8; 10], 100, 100);
        assert!(result.contains("\"count\":0"));
    }

    #[test]
    fn test_detect_obstacles_uniform_black() {
        let w = 128u32;
        let h = 128u32;
        let rgba = vec![0u8; (w * h * 4) as usize];
        let result = detect_obstacles(&rgba, w, h);
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["count"], 0);
    }

    #[test]
    fn test_detect_obstacles_bright_blob_on_dark() {
        // Create a dark image with a bright rectangle → should detect it.
        // Image must be large enough that the blob survives 2×2 pooling and exceeds MIN_AREA (1500).
        // A 400×400 image with a 120×80 blob: pooled blob ≈ 60×40 = 2400 > 1500.
        let w = 400u32;
        let h = 400u32;
        let mut rgba = vec![10u8; (w * h * 4) as usize];
        // Set alpha channel to 255
        for i in 0..(w * h) as usize {
            rgba[i * 4 + 3] = 255;
        }
        // Draw a bright rectangle (120×80) in the center
        for y in 160..240 {
            for x in 140..260 {
                let idx = (y * w as usize + x) * 4;
                rgba[idx] = 220;
                rgba[idx + 1] = 220;
                rgba[idx + 2] = 220;
                rgba[idx + 3] = 255;
            }
        }
        let result = detect_obstacles(&rgba, w, h);
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        // Should find at least one obstacle
        assert!(
            parsed["count"].as_u64().unwrap() >= 1,
            "Expected at least 1 detection, got: {result}"
        );
    }
}
