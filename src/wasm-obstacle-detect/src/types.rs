use serde::Serialize;

/// Axis-aligned bounding box.
#[derive(Debug, Clone, Serialize)]
pub struct BBox {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// Oriented (rotated) bounding box.
#[derive(Debug, Clone, Serialize)]
pub struct OrientedBBox {
    pub center_x: f32,
    pub center_y: f32,
    pub width: f32,
    pub height: f32,
    /// Angle in degrees. 0° = pointing right, 90° = pointing up.
    pub angle: f32,
}

/// A single detected obstacle.
#[derive(Debug, Clone, Serialize)]
pub struct Obstacle {
    pub id: u32,
    pub bbox: BBox,
    pub oriented_bbox: OrientedBBox,
    pub area: u32,
    /// Principal axis orientation in degrees.
    pub orientation_deg: f32,
    /// How distinct the object is from the background (0.0–1.0).
    pub confidence: f32,
}

/// Full detection result returned as JSON.
#[derive(Debug, Clone, Serialize)]
pub struct DetectionResult {
    pub obstacles: Vec<Obstacle>,
    pub count: usize,
    pub processing_time_ms: f64,
}

/// Internal representation of a connected component.
#[derive(Debug, Clone)]
pub struct Component {
    pub label: u32,
    pub pixels: Vec<(u32, u32)>,
    pub min_x: u32,
    pub min_y: u32,
    pub max_x: u32,
    pub max_y: u32,
}

impl Component {
    pub fn new(label: u32) -> Self {
        Self {
            label,
            pixels: Vec::new(),
            min_x: u32::MAX,
            min_y: u32::MAX,
            max_x: 0,
            max_y: 0,
        }
    }

    pub fn add_pixel(&mut self, x: u32, y: u32) {
        self.pixels.push((x, y));
        self.min_x = self.min_x.min(x);
        self.min_y = self.min_y.min(y);
        self.max_x = self.max_x.max(x);
        self.max_y = self.max_y.max(y);
    }

    pub fn area(&self) -> u32 {
        self.pixels.len() as u32
    }

    pub fn bbox(&self) -> BBox {
        BBox {
            x: self.min_x,
            y: self.min_y,
            width: self.max_x - self.min_x + 1,
            height: self.max_y - self.min_y + 1,
        }
    }
}
