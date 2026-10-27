//! Read the current user's manually configured Windows Internet Settings proxy.
//! PAC/WPAD rules need a per-request resolver and are intentionally left to the OS.

use std::ffi::c_void;
use std::ptr;
use windows_sys::Win32::Foundation::ERROR_SUCCESS;
use windows_sys::Win32::System::Registry::{
    RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
};

const SETTINGS_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const MAX_VALUE_BYTES: usize = 16 * 1024;

pub(super) struct ManualProxy {
    pub http: Option<String>,
    pub https: Option<String>,
    pub bypass: Option<String>,
}

pub(super) fn current_user_manual_proxy() -> Option<ManualProxy> {
    if read_dword("ProxyEnable")? == 0 {
        return None;
    }
    let server = read_string("ProxyServer")?;
    let (http, https) = parse_proxy_server(&server);
    if http.is_none() && https.is_none() {
        return None;
    }
    let bypass = read_string("ProxyOverride").and_then(|value| parse_proxy_override(&value));
    Some(ManualProxy {
        http,
        https,
        bypass,
    })
}

fn read_dword(name: &str) -> Option<u32> {
    let key = wide(SETTINGS_KEY);
    let value = wide(name);
    let mut result = 0u32;
    let mut bytes = std::mem::size_of::<u32>() as u32;
    // SAFETY: pointers refer to live, correctly sized values for this call.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_DWORD,
            ptr::null_mut(),
            (&mut result as *mut u32).cast::<c_void>(),
            &mut bytes,
        )
    };
    (status == ERROR_SUCCESS && bytes == 4).then_some(result)
}

fn read_string(name: &str) -> Option<String> {
    let key = wide(SETTINGS_KEY);
    let value = wide(name);
    let mut buffer = [0u16; MAX_VALUE_BYTES / 2];
    let mut bytes = MAX_VALUE_BYTES as u32;
    // SAFETY: the output buffer has `bytes` writable bytes; RegGetValueW
    // NUL-terminates REG_SZ values within the reported length on success.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            ptr::null_mut(),
            buffer.as_mut_ptr().cast::<c_void>(),
            &mut bytes,
        )
    };
    if status != ERROR_SUCCESS
        || bytes < 2
        || bytes as usize > MAX_VALUE_BYTES
        || !bytes.is_multiple_of(2)
    {
        return None;
    }
    let units = &buffer[..bytes as usize / 2];
    let end = units.iter().position(|unit| *unit == 0)?;
    String::from_utf16(&units[..end]).ok()
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn parse_proxy_server(value: &str) -> (Option<String>, Option<String>) {
    let value = value.trim();
    if !value.contains('=') {
        let url = proxy_url(value);
        return (url.clone(), url);
    }
    let mut http = None;
    let mut https = None;
    for part in value.split(';') {
        let Some((scheme, server)) = part.split_once('=') else {
            continue;
        };
        match scheme.trim().to_ascii_lowercase().as_str() {
            "http" => http = proxy_url(server.trim()),
            "https" => https = proxy_url(server.trim()),
            _ => {}
        }
    }
    (http, https)
}

fn proxy_url(value: &str) -> Option<String> {
    let candidate = if value.starts_with("http://") || value.starts_with("https://") {
        value.to_owned()
    } else {
        format!("http://{value}")
    };
    let parsed = url::Url::parse(&candidate).ok()?;
    if parsed.host_str().is_none()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }
    Some(candidate)
}

fn parse_proxy_override(value: &str) -> Option<String> {
    let entries: Vec<&str> = value
        .split([';', ','])
        .map(str::trim)
        .filter(|entry| !entry.is_empty() && !entry.eq_ignore_ascii_case("<local>"))
        .collect();
    (!entries.is_empty()).then(|| entries.join(","))
}

#[cfg(test)]
mod tests {
    use super::{parse_proxy_override, parse_proxy_server};

    #[test]
    fn parses_windows_manual_proxy_forms() {
        assert_eq!(
            parse_proxy_server("proxy.example:8080"),
            (
                Some("http://proxy.example:8080".into()),
                Some("http://proxy.example:8080".into())
            )
        );
        assert_eq!(
            parse_proxy_server("proxy.example"),
            (
                Some("http://proxy.example".into()),
                Some("http://proxy.example".into())
            )
        );
        assert_eq!(
            parse_proxy_server("http=one.example:80;https=two.example:443;socks=third:1080"),
            (
                Some("http://one.example:80".into()),
                Some("http://two.example:443".into())
            )
        );
        assert_eq!(parse_proxy_server("http=invalid/path"), (None, None));
    }

    #[test]
    fn converts_windows_bypass_entries() {
        assert_eq!(
            parse_proxy_override("*.internal;<local>;10.0.0.0/8"),
            Some("*.internal,10.0.0.0/8".into())
        );
        assert_eq!(parse_proxy_override("<local>"), None);
    }
}
