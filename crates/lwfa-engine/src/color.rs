//! Named source colorimetry and display-referred color conversion.
//!
//! All arithmetic uses straight linear-light RGB in cd/m². Callers must
//! unpremultiply before decoding and premultiply again before composition.

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Primaries {
    #[default]
    Srgb,
    DisplayP3,
    Bt2020,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Transfer {
    #[default]
    Srgb,
    Bt1886,
    Pq,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Description {
    pub primaries: Primaries,
    pub transfer: Transfer,
    pub reference_white: f32,
    pub min_luminance: f32,
    pub max_luminance: f32,
    pub target_peak: f32,
}

impl Default for Description {
    fn default() -> Self {
        Self {
            primaries: Primaries::Srgb,
            transfer: Transfer::Srgb,
            reference_white: 80.0,
            min_luminance: 0.2,
            max_luminance: 80.0,
            target_peak: 80.0,
        }
    }
}

impl Description {
    pub fn named(primaries: Primaries, transfer: Transfer) -> Self {
        match transfer {
            Transfer::Pq => Self {
                primaries,
                transfer,
                reference_white: 203.0,
                min_luminance: 0.005,
                max_luminance: 10000.005,
                target_peak: 10000.0,
            },
            Transfer::Bt1886 => Self {
                primaries,
                transfer,
                reference_white: 100.0,
                min_luminance: 0.01,
                max_luminance: 100.0,
                target_peak: 100.0,
            },
            Transfer::Srgb => Self {
                primaries,
                ..Self::default()
            },
        }
    }
}

const M1: f32 = 2610.0 / 16384.0;
const M2: f32 = 2523.0 / 32.0;
const C1: f32 = 3424.0 / 4096.0;
const C2: f32 = 2413.0 / 128.0;
const C3: f32 = 2392.0 / 128.0;

pub fn decode(value: f32, description: Description) -> f32 {
    let value = value.clamp(0.0, 1.0);
    match description.transfer {
        Transfer::Srgb => {
            (if value <= 0.04045 {
                value / 12.92
            } else {
                ((value + 0.055) / 1.055).powf(2.4)
            }) * (description.max_luminance - description.min_luminance)
                + description.min_luminance
        }
        Transfer::Bt1886 => {
            let black = description.min_luminance.powf(1.0 / 2.4);
            let white = description.max_luminance.powf(1.0 / 2.4);
            (value * (white - black) + black).powf(2.4)
        }
        Transfer::Pq => {
            let power = value.powf(1.0 / M2);
            ((power - C1).max(0.0) / (C2 - C3 * power)).powf(1.0 / M1) * 10000.0
                + description.min_luminance
        }
    }
}

pub fn encode_srgb(value: f32) -> f32 {
    let value = value.clamp(0.0, 1.0);
    if value <= 0.0031308 {
        value * 12.92
    } else {
        1.055 * value.powf(1.0 / 2.4) - 0.055
    }
}

#[cfg(test)]
pub fn encode_pq(nits: f32) -> f32 {
    let power = (nits.clamp(0.0, 10000.0) / 10000.0).powf(M1);
    ((C1 + C2 * power) / (1.0 + C3 * power)).powf(M2)
}

/// Linear RGB to linear sRGB, all spaces using D65 white.
pub fn to_srgb(rgb: [f32; 3], primaries: Primaries) -> [f32; 3] {
    let matrix = match primaries {
        Primaries::Srgb => return rgb,
        Primaries::DisplayP3 => [
            [1.224745, -0.224904, 0.0],
            [-0.042058, 1.042081, 0.0],
            [-0.019642, -0.078655, 1.098537],
        ],
        Primaries::Bt2020 => [
            [1.660491, -0.587641, -0.072850],
            [-0.124550, 1.1329, -0.008349],
            [-0.018151, -0.100579, 1.11873],
        ],
    };
    matrix.map(|row| row.iter().zip(rgb).map(|(a, b)| a * b).sum())
}

/// A monotonic shoulder preserving diffuse white ratios and avoiding clipping
/// all HDR highlights to the same value. This is an engineering rendering
/// policy, not a claim to implement an ICC perceptual intent transform.
pub fn tone_map(rgb: [f32; 3], reference_white: f32, peak: f32) -> [f32; 3] {
    let rgb = rgb.map(|v| (v / reference_white).max(0.0));
    let luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    if peak <= reference_white || luminance <= 0.0 {
        return rgb;
    }
    let white = (peak / reference_white).max(1.0);
    let mapped = luminance * (1.0 + luminance / (white * white)) / (1.0 + luminance);
    rgb.map(|v| v * mapped / luminance)
}

/// Packed ABGR2101010 readback to limited-range BT.2020 non-constant-luminance
/// P010. Chroma is averaged in the encoded domain, with edge replication.
pub fn p010_from_rgb10(bytes: &[u8], width: u32, height: u32) -> ffmpeg_next::frame::Video {
    let mut frame =
        ffmpeg_next::frame::Video::new(ffmpeg_next::format::Pixel::P010LE, width, height);
    let rgb = |x: u32, y: u32| {
        let offset = ((y.min(height - 1) * width + x.min(width - 1)) * 4) as usize;
        let packed = u32::from_ne_bytes(bytes[offset..offset + 4].try_into().unwrap());
        [
            (packed & 1023) as f32 / 1023.0,
            ((packed >> 10) & 1023) as f32 / 1023.0,
            ((packed >> 20) & 1023) as f32 / 1023.0,
        ]
    };
    let yuv = |rgb: [f32; 3]| {
        let y = 0.2627 * rgb[0] + 0.6780 * rgb[1] + 0.0593 * rgb[2];
        [y, (rgb[2] - y) / 1.8814, (rgb[0] - y) / 1.4746]
    };
    let stride = frame.stride(0);
    for y in 0..height {
        for x in 0..width {
            let value = ((64.0 + 876.0 * yuv(rgb(x, y))[0])
                .round()
                .clamp(64.0, 940.0) as u16)
                << 6;
            let offset = y as usize * stride + x as usize * 2;
            frame.data_mut(0)[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
        }
    }
    let stride = frame.stride(1);
    for y in (0..height).step_by(2) {
        for x in (0..width).step_by(2) {
            let samples = [
                yuv(rgb(x, y)),
                yuv(rgb(x + 1, y)),
                yuv(rgb(x, y + 1)),
                yuv(rgb(x + 1, y + 1)),
            ];
            for channel in 1..=2 {
                let chroma = samples.iter().map(|sample| sample[channel]).sum::<f32>() / 4.0;
                let value = ((512.0 + 896.0 * chroma).round().clamp(64.0, 960.0) as u16) << 6;
                let offset = (y / 2) as usize * stride + (x / 2) as usize * 4 + (channel - 1) * 2;
                frame.data_mut(1)[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
            }
        }
    }
    frame
}

/// SDR fallback for an HDR encoder failure. Never pass PQ pixels to JPEG.
pub fn p010_to_srgb(frame: &ffmpeg_next::frame::Video, peak: f32) -> Vec<u8> {
    let mut pixels = Vec::with_capacity(frame.width() as usize * frame.height() as usize * 4);
    let read = |plane: usize, offset: usize| {
        (u16::from_le_bytes(frame.data(plane)[offset..offset + 2].try_into().unwrap()) >> 6) as f32
    };
    let pq = Description::named(Primaries::Bt2020, Transfer::Pq);
    for y in 0..frame.height() as usize {
        for x in 0..frame.width() as usize {
            let luma = (read(0, y * frame.stride(0) + x * 2) - 64.0) / 876.0;
            let cb = (read(1, y / 2 * frame.stride(1) + x / 2 * 4) - 512.0) / 896.0;
            let cr = (read(1, y / 2 * frame.stride(1) + x / 2 * 4 + 2) - 512.0) / 896.0;
            let r = luma + 1.4746 * cr;
            let b = luma + 1.8814 * cb;
            let g = (luma - 0.2627 * r - 0.0593 * b) / 0.6780;
            let linear = to_srgb([r, g, b].map(|v| decode(v, pq)), Primaries::Bt2020);
            let mapped = tone_map(linear, 203.0, peak);
            pixels.extend(mapped.map(|v| (encode_srgb(v) * 255.0).round() as u8));
            pixels.push(255);
        }
    }
    pixels
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn p010_conversion_uses_limited_range_bt2020_and_preserves_sdr_fallback_white() {
        let red = 1023_u32 | 3 << 30;
        let bytes: Vec<_> = (0..4).flat_map(|_| red.to_ne_bytes()).collect();
        let frame = p010_from_rgb10(&bytes, 2, 2);
        let code = |plane, offset| {
            u16::from_le_bytes(frame.data(plane)[offset..offset + 2].try_into().unwrap()) >> 6
        };
        assert_eq!(code(0, 0), 294);
        assert_eq!(code(1, 0), 387);
        assert_eq!(code(1, 2), 960);
        let white = (encode_pq(203.0) * 1023.0).round() as u32;
        let packed = white | white << 10 | white << 20 | 3 << 30;
        let bytes: Vec<_> = (0..9).flat_map(|_| packed.to_ne_bytes()).collect();
        let frame = p010_from_rgb10(&bytes, 3, 3);
        let pixels = p010_to_srgb(&frame, 203.0);
        assert_eq!(pixels.len(), 3 * 3 * 4);
        assert!(
            pixels.iter().all(|value| *value >= 253),
            "SDR diffuse white must not be darkened by HDR JPEG fallback"
        );
    }

    #[test]
    fn pq_has_absolute_luminance_and_round_trips() {
        let pq = Description::named(Primaries::Bt2020, Transfer::Pq);
        assert!((decode(0.5080784, pq) - 100.0).abs() < 0.02);
        for nits in [0.0, 0.1, 1.0, 80.0, 203.0, 1000.0, 10000.0] {
            assert!((decode(encode_pq(nits), pq) - nits).abs() < (nits * 0.0001).max(0.01));
        }
    }

    #[test]
    fn srgb_round_trips_and_untagged_white_is_80_nits() {
        let source = Description::default();
        for code in 0..=255 {
            let value = code as f32 / 255.0;
            assert!(
                (encode_srgb(
                    (decode(value, source) - source.min_luminance) / (80.0 - source.min_luminance)
                ) - value)
                    .abs()
                    < 0.00001
            );
        }
        assert!((decode(1.0, source) - 80.0).abs() < 0.001);
    }

    #[test]
    fn d65_white_stays_neutral_and_hdr_shoulder_is_monotonic() {
        for primaries in [Primaries::Srgb, Primaries::DisplayP3, Primaries::Bt2020] {
            assert!(
                to_srgb([1.0; 3], primaries)
                    .iter()
                    .all(|v| (*v - 1.0).abs() < 0.001)
            );
        }
        let mut previous = 0.0;
        for nits in 0..=1000 {
            let mapped = tone_map([nits as f32; 3], 203.0, 1000.0)[0];
            assert!(mapped >= previous && mapped.is_finite());
            previous = mapped;
        }
        assert!((previous - 1.0).abs() < 0.0001);
    }
}
