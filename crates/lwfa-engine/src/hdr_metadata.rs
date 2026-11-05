//! HDR10 static SEI for the composited stream's virtual BT.2020 display.
//! Emitted independently of the NVENC SDK: older FFmpeg/SDK builds silently
//! ignore mastering AVFrame side data. Source mastering metadata describes
//! inputs, not the resulting composited display. Unknown MaxFALL is zero.

/// Insert prefix SEI after parameter sets and before the first VCL NAL. Every
/// IDR is independently usable, including by viewers joining mid-stream.
pub fn insert(bytes: &mut Vec<u8>, peak: f32) {
    let mut rbsp = vec![137, 24]; // mastering_display_colour_volume
    // HEVC carries primaries in G, B, R order, chromaticities scaled by 50000.
    for coordinate in [8500_u16, 39850, 6550, 2300, 35400, 14600, 15635, 16450] {
        rbsp.extend_from_slice(&coordinate.to_be_bytes());
    }
    rbsp.extend_from_slice(&100_000_000_u32.to_be_bytes()); // 10000 cd/m²
    rbsp.extend_from_slice(&0_u32.to_be_bytes());
    rbsp.extend_from_slice(&[144, 4]); // content_light_level_info
    rbsp.extend_from_slice(&(peak.clamp(1.0, 10000.0).ceil() as u16).to_be_bytes());
    rbsp.extend_from_slice(&0_u16.to_be_bytes()); // unknown MaxFALL
    rbsp.push(0x80); // rbsp_trailing_bits
    let mut nal = vec![0, 0, 0, 1, 39 << 1, 1]; // PREFIX_SEI_NUT, temporal_id_plus1=1
    let mut zeros = 0;
    for byte in rbsp {
        if zeros == 2 && byte <= 3 {
            nal.push(3);
            zeros = 0;
        }
        nal.push(byte);
        zeros = if byte == 0 { zeros + 1 } else { 0 };
    }
    let mut insertion = bytes.len();
    let mut i = 0;
    while i + 4 <= bytes.len() {
        let prefix = if bytes[i..].starts_with(&[0, 0, 0, 1]) {
            4
        } else if bytes[i..].starts_with(&[0, 0, 1]) {
            3
        } else {
            i += 1;
            continue;
        };
        if let Some(header) = bytes.get(i + prefix) {
            if (header >> 1) & 63 <= 31 {
                insertion = i;
                break;
            }
        }
        i += prefix;
    }
    bytes.splice(insertion..insertion, nal);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn static_metadata_precedes_vcl_without_changing_parameter_sets() {
        let parameters = vec![0, 0, 0, 1, 32 << 1, 1, 7, 0, 0, 1, 33 << 1, 1, 8];
        let vcl = vec![0, 0, 1, 19 << 1, 1, 9];
        let mut bytes = [parameters.clone(), vcl.clone()].concat();
        insert(&mut bytes, 1000.0);
        assert!(bytes.starts_with(&parameters));
        assert!(bytes.ends_with(&vcl));
        let sei = &bytes[parameters.len()..bytes.len() - vcl.len()];
        assert!(sei.starts_with(&[0, 0, 0, 1, 78, 1, 137, 24]));
        assert!(
            !sei[6..]
                .windows(3)
                .any(|b| b == [0, 0, 0] || b == [0, 0, 1] || b == [0, 0, 2])
        );
        assert!(sei.windows(6).any(|b| b == [144, 4, 3, 232, 0, 0]));
    }
}
