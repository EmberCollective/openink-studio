use serde::{Deserialize, Serialize};

/// Millimetres in page coordinates: X right, Y down. Device flips Y once.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}
pub type Stroke = Vec<Point>;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Document {
    pub name: String,
    pub width_mm: f64,
    pub height_mm: f64,
    pub strokes: Vec<Stroke>,
}
