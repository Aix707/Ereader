use crate::db::Result;
use serde_json::{json, Value};
#[cfg(windows)]
pub fn fonts() -> Result<Value> {
  use windows::Win32::Graphics::DirectWrite::*;
  unsafe {
    let factory: IDWriteFactory =
      DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED).map_err(|e| e.to_string())?;
    let mut collection = None;
    factory
      .GetSystemFontCollection(&mut collection, false)
      .map_err(|e| e.to_string())?;
    let collection = collection.ok_or("Missing font collection")?;
    let mut fonts = std::collections::BTreeSet::new();
    for index in 0..collection.GetFontFamilyCount() {
      let family = collection.GetFontFamily(index).map_err(|e| e.to_string())?;
      let names = family.GetFamilyNames().map_err(|e| e.to_string())?;
      for n in 0..names.GetCount() {
        let length = names.GetStringLength(n).map_err(|e| e.to_string())?;
        let mut buffer = vec![0; length as usize + 1];
        names.GetString(n, &mut buffer).map_err(|e| e.to_string())?;
        fonts.insert(String::from_utf16_lossy(&buffer[..length as usize]));
      }
    }
    Ok(json!(fonts
      .into_iter()
      .map(|family| json!({"family":family,"source":"system"}))
      .collect::<Vec<_>>()))
  }
}
#[cfg(not(windows))]
pub fn fonts() -> Result<Value> {
  Ok(json!([]))
}

#[cfg(windows)]
pub fn tiff(bytes: &[u8]) -> Result<Vec<u8>> {
  use windows::Win32::{Graphics::Imaging::*, System::Com::*};
  unsafe {
    let initialized = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
    let result = (|| {
      let factory: IWICImagingFactory =
        CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)
          .map_err(|e| e.to_string())?;
      let stream = factory.CreateStream().map_err(|e| e.to_string())?;
      stream
        .InitializeFromMemory(bytes)
        .map_err(|e| e.to_string())?;
      let decoder = factory
        .CreateDecoderFromStream(&stream, std::ptr::null(), WICDecodeMetadataCacheOnLoad)
        .map_err(|e| e.to_string())?;
      let original = decoder.GetFrame(0).map_err(|e| e.to_string())?;
      let frame = factory
        .CreateBitmapFlipRotator()
        .map_err(|e| e.to_string())?;
      let transform = match tiff_orientation(bytes) {
        2 => 8,
        3 => 2,
        4 => 16,
        5 => 3 | 8,
        6 => 1,
        7 => 1 | 8,
        8 => 3,
        _ => 0,
      };
      frame
        .Initialize(&original, WICBitmapTransformOptions(transform))
        .map_err(|e| e.to_string())?;
      let (mut width, mut height) = (0, 0);
      frame
        .GetSize(&mut width, &mut height)
        .map_err(|e| e.to_string())?;
      if width == 0 || height == 0 || width as u64 * height as u64 > 250_000_000 {
        return Err("TIFF exceeds decoding budget".into());
      }
      let scale = (3200f64 / width.max(height) as f64).min(1.);
      width = (width as f64 * scale).round().max(1.) as u32;
      height = (height as f64 * scale).round().max(1.) as u32;
      let scaler = factory.CreateBitmapScaler().map_err(|e| e.to_string())?;
      scaler
        .Initialize(&frame, width, height, WICBitmapInterpolationModeFant)
        .map_err(|e| e.to_string())?;
      let converter = factory.CreateFormatConverter().map_err(|e| e.to_string())?;
      converter
        .Initialize(
          &scaler,
          &GUID_WICPixelFormat32bppRGBA,
          WICBitmapDitherTypeNone,
          None,
          0.,
          WICBitmapPaletteTypeCustom,
        )
        .map_err(|e| e.to_string())?;
      let mut output = vec![0; 8 + (width as usize * height as usize * 4)];
      output[..4].copy_from_slice(&width.to_le_bytes());
      output[4..8].copy_from_slice(&height.to_le_bytes());
      converter
        .CopyPixels(std::ptr::null(), width * 4, &mut output[8..])
        .map_err(|e| e.to_string())?;
      Ok(output)
    })();
    if initialized {
      CoUninitialize();
    }
    result
  }
}

fn tiff_orientation(bytes: &[u8]) -> u16 {
  let little = bytes.starts_with(b"II");
  let short = |offset: usize| -> Option<u16> {
    let data: [u8; 2] = bytes.get(offset..offset.checked_add(2)?)?.try_into().ok()?;
    Some(if little {
      u16::from_le_bytes(data)
    } else {
      u16::from_be_bytes(data)
    })
  };
  let long = |offset: usize| -> Option<u32> {
    let data: [u8; 4] = bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?;
    Some(if little {
      u32::from_le_bytes(data)
    } else {
      u32::from_be_bytes(data)
    })
  };
  let Some(ifd) = long(4).map(|n| n as usize) else {
    return 1;
  };
  let Some(count) = short(ifd) else {
    return 1;
  };
  for i in 0..count as usize {
    let Some(offset) = ifd.checked_add(2 + i * 12) else {
      return 1;
    };
    if short(offset) == Some(274) && short(offset + 2) == Some(3) && long(offset + 4) == Some(1) {
      return short(offset + 8).unwrap_or(1);
    }
  }
  1
}
#[cfg(not(windows))]
pub fn tiff(_: &[u8]) -> Result<Vec<u8>> {
  Err("TIFF decoding requires Windows".into())
}
