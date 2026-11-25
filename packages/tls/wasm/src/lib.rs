//! Thin wasm-bindgen wrapper around rustls' buffered client connection.
//!
//! This file contains NO protocol or certificate logic of its own: the TLS state machine is
//! `rustls`, certificate path building / name / validity / signature checks are `rustls-webpki`,
//! and the primitives are `ring`. The wrapper only moves bytes in and out, injects the clock, and
//! maps `rustls::Error` onto a small set of numeric classes for the TypeScript side.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rustls::client::Resumption;
use rustls::pki_types::{CertificateDer, Der, ServerName, TrustAnchor, UnixTime};
use rustls::time_provider::TimeProvider;
use rustls::{
    AlertDescription, CertificateError, ClientConfig, ClientConnection, Error, PeerIncompatible,
    RootCertStore, SupportedProtocolVersion,
};
use wasm_bindgen::prelude::*;

// Error classes shared with src/index.ts (keep in sync).
const E_NONE: u32 = 0;
const E_CERT_UNTRUSTED: u32 = 1;
const E_CERT_NAME: u32 = 2;
const E_CERT_EXPIRED: u32 = 3;
const E_CERT_NOT_YET_VALID: u32 = 4;
const E_CERT_INVALID: u32 = 5;
const E_PROTOCOL_VERSION: u32 = 6;
const E_OTHER: u32 = 7;

/// The clock rustls sees. Set by the caller before every call that can verify a certificate, so
/// that `now` is fully under the embedding application's control (and testable).
#[derive(Debug)]
struct Clock(AtomicU64);

impl TimeProvider for Clock {
    fn current_time(&self) -> Option<UnixTime> {
        Some(UnixTime::since_unix_epoch(Duration::from_secs(
            self.0.load(Ordering::Relaxed),
        )))
    }
}

fn put(out: &mut Vec<u8>, bytes: &[u8]) -> Result<(), JsError> {
    let len = u16::try_from(bytes.len()).map_err(|_| JsError::new("trust anchor field too long"))?;
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(bytes);
    Ok(())
}

fn take<'a>(input: &mut &'a [u8]) -> Result<&'a [u8], JsError> {
    let bad = || JsError::new("malformed packed trust anchors");
    if input.len() < 2 {
        return Err(bad());
    }
    let len = u16::from_be_bytes([input[0], input[1]]) as usize;
    if input.len() < 2 + len {
        return Err(bad());
    }
    let (head, rest) = input[2..].split_at(len);
    *input = rest;
    Ok(head)
}

/// Extract the trust-anchor fields (subject, SPKI, name constraints) from a DER certificate using
/// webpki, in the packed form `Roots::add_packed` accepts:
/// repeated `u16be len | subject`, `u16be len | spki`, `u16be len | nameConstraints (may be empty)`.
#[wasm_bindgen]
pub fn pack_anchor(cert_der: &[u8]) -> Result<Vec<u8>, JsError> {
    let cert = CertificateDer::from(cert_der);
    let ta = webpki::anchor_from_trusted_cert(&cert)
        .map_err(|e| JsError::new(&format!("not a usable trust anchor: {e:?}")))?;
    let mut out = Vec::new();
    put(&mut out, ta.subject.as_ref())?;
    put(&mut out, ta.subject_public_key_info.as_ref())?;
    put(
        &mut out,
        ta.name_constraints.as_ref().map(|d| d.as_ref()).unwrap_or(&[]),
    )?;
    Ok(out)
}

#[wasm_bindgen]
pub struct Roots {
    store: RootCertStore,
}

#[wasm_bindgen]
impl Roots {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Roots {
        Roots { store: RootCertStore::empty() }
    }

    /// Add trust anchors in the packed form produced by `pack_anchor` (concatenated).
    pub fn add_packed(&mut self, mut packed: &[u8]) -> Result<(), JsError> {
        while !packed.is_empty() {
            let subject = take(&mut packed)?;
            let spki = take(&mut packed)?;
            let nc = take(&mut packed)?;
            self.store.roots.push(TrustAnchor {
                subject: Der::from(subject.to_vec()),
                subject_public_key_info: Der::from(spki.to_vec()),
                name_constraints: if nc.is_empty() { None } else { Some(Der::from(nc.to_vec())) },
            });
        }
        Ok(())
    }

    pub fn len(&self) -> usize {
        self.store.roots.len()
    }
}

#[wasm_bindgen]
pub struct Conn {
    conn: ClientConnection,
    clock: Arc<Clock>,
    tls_out: Vec<u8>,
    plain_out: Vec<u8>,
    peer_closed: bool,
    err_class: u32,
    err_msg: String,
}

fn classify(e: &Error) -> u32 {
    match e {
        Error::InvalidCertificate(c) => match c {
            CertificateError::UnknownIssuer => E_CERT_UNTRUSTED,
            CertificateError::NotValidForName | CertificateError::NotValidForNameContext { .. } => {
                E_CERT_NAME
            }
            CertificateError::Expired | CertificateError::ExpiredContext { .. } => E_CERT_EXPIRED,
            CertificateError::NotValidYet | CertificateError::NotValidYetContext { .. } => {
                E_CERT_NOT_YET_VALID
            }
            _ => E_CERT_INVALID,
        },
        Error::PeerIncompatible(
            PeerIncompatible::ServerDoesNotSupportTls12Or13
            | PeerIncompatible::ServerTlsVersionIsDisabledByOurConfig
            | PeerIncompatible::SupportedVersionsExtensionRequired
            | PeerIncompatible::Tls12NotOffered
            | PeerIncompatible::Tls12NotOfferedOrEnabled,
        ) => E_PROTOCOL_VERSION,
        Error::AlertReceived(AlertDescription::ProtocolVersion) => E_PROTOCOL_VERSION,
        _ => E_OTHER,
    }
}

#[wasm_bindgen]
impl Conn {
    /// `alpn_wire`: concatenated `u8 len | protocol` entries, in preference order.
    /// `versions`: bit 0 = TLS 1.2, bit 1 = TLS 1.3.
    #[wasm_bindgen(constructor)]
    pub fn new(
        roots: &Roots,
        server_name: &str,
        mut alpn_wire: &[u8],
        versions: u32,
        now_secs: f64,
    ) -> Result<Conn, JsError> {
        let clock = Arc::new(Clock(AtomicU64::new(now_secs as u64)));
        let mut vers: Vec<&'static SupportedProtocolVersion> = Vec::new();
        if versions & 2 != 0 {
            vers.push(&rustls::version::TLS13);
        }
        if versions & 1 != 0 {
            vers.push(&rustls::version::TLS12);
        }
        let mut provider = rustls::crypto::ring::default_provider();
        // Prefer ChaCha20-Poly1305: without AES-NI/CLMUL (there is none in wasm) it is both the
        // fastest AEAD and the one with the simplest constant-time story. AES-GCM stays enabled.
        provider
            .cipher_suites
            .sort_by_key(|s| !format!("{:?}", s.suite()).contains("CHACHA20"));
        let mut config = ClientConfig::builder_with_details(Arc::new(provider), clock.clone())
            .with_protocol_versions(&vers)
            .map_err(|e| JsError::new(&e.to_string()))?
            .with_root_certificates(roots.store.clone())
            .with_no_client_auth();
        while !alpn_wire.is_empty() {
            let n = alpn_wire[0] as usize;
            if n == 0 || alpn_wire.len() < 1 + n {
                return Err(JsError::new("malformed ALPN list"));
            }
            config.alpn_protocols.push(alpn_wire[1..1 + n].to_vec());
            alpn_wire = &alpn_wire[1 + n..];
        }
        // No session resumption / 0-RTT: every connection does a full handshake with full
        // certificate verification, and nothing is cached across connections.
        config.resumption = Resumption::disabled();
        config.enable_early_data = false;

        let name = ServerName::try_from(server_name.to_owned())
            .map_err(|_| JsError::new("invalid server name"))?;
        let mut conn = ClientConnection::new(Arc::new(config), name)
            .map_err(|e| JsError::new(&e.to_string()))?;
        conn.set_buffer_limit(None);
        let mut this = Conn {
            conn,
            clock,
            tls_out: Vec::new(),
            plain_out: Vec::new(),
            peer_closed: false,
            err_class: E_NONE,
            err_msg: String::new(),
        };
        this.flush_tls();
        Ok(this)
    }

    fn flush_tls(&mut self) {
        while self.conn.wants_write() {
            if self.conn.write_tls(&mut self.tls_out).is_err() {
                break;
            }
        }
    }

    fn fail(&mut self, class: u32, msg: String) -> u32 {
        self.err_class = class;
        self.err_msg = msg;
        class
    }

    /// Feed ciphertext from the transport. Returns 0, or an error class (sticky). Afterwards the
    /// caller must drain `take_tls()` (also on error: it holds the alert) and `take_plain()`.
    pub fn feed(&mut self, mut data: &[u8], now_secs: f64) -> u32 {
        if self.err_class != E_NONE {
            return self.err_class;
        }
        self.clock.0.store(now_secs as u64, Ordering::Relaxed);
        while !data.is_empty() {
            match self.conn.read_tls(&mut data) {
                Ok(0) => break,
                Ok(_) => {}
                Err(e) => return self.fail(E_OTHER, e.to_string()),
            }
            match self.conn.process_new_packets() {
                Ok(state) => {
                    let n = state.plaintext_bytes_to_read();
                    if n > 0 {
                        let old = self.plain_out.len();
                        self.plain_out.resize(old + n, 0);
                        if let Err(e) = self.conn.reader().read_exact(&mut self.plain_out[old..]) {
                            return self.fail(E_OTHER, e.to_string());
                        }
                    }
                    if state.peer_has_closed() {
                        self.peer_closed = true;
                    }
                }
                Err(e) => {
                    self.flush_tls();
                    return self.fail(classify(&e), e.to_string());
                }
            }
        }
        self.flush_tls();
        E_NONE
    }

    /// Encrypt application data. Returns false if the connection cannot accept it.
    pub fn write(&mut self, data: &[u8]) -> bool {
        if self.err_class != E_NONE || self.conn.is_handshaking() {
            return false;
        }
        let ok = self.conn.writer().write_all(data).is_ok();
        self.flush_tls();
        ok
    }

    pub fn send_close_notify(&mut self) {
        self.conn.send_close_notify();
        self.flush_tls();
    }

    pub fn take_tls(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.tls_out)
    }

    pub fn take_plain(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.plain_out)
    }

    pub fn is_handshaking(&self) -> bool {
        self.conn.is_handshaking()
    }

    /// True once the peer's close_notify alert has been received.
    pub fn peer_closed(&self) -> bool {
        self.peer_closed
    }

    pub fn alpn(&self) -> Option<Vec<u8>> {
        self.conn.alpn_protocol().map(|p| p.to_vec())
    }

    /// Negotiated protocol version on the wire (0x0303 / 0x0304), 0 if not yet known.
    pub fn version(&self) -> u16 {
        self.conn.protocol_version().map(u16::from).unwrap_or(0)
    }

    pub fn cipher_suite(&self) -> String {
        self.conn
            .negotiated_cipher_suite()
            .map(|s| format!("{:?}", s.suite()))
            .unwrap_or_default()
    }

    pub fn err_class(&self) -> u32 {
        self.err_class
    }

    pub fn err_msg(&self) -> String {
        self.err_msg.clone()
    }
}
