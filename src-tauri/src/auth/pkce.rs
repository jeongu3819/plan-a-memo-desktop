//! PKCE (RFC 7636, S256). verifier 는 메모리에만 두고 로그에 남기지 않는다.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use sha2::{Digest, Sha256};

pub struct PkcePair {
    pub verifier: String,
    pub challenge: String,
    pub method: &'static str,
}

impl std::fmt::Debug for PkcePair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PkcePair").field("verifier", &"<redacted>").field("challenge", &self.challenge).finish()
    }
}

impl PkcePair {
    pub fn generate() -> Self {
        let mut bytes = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        let verifier = URL_SAFE_NO_PAD.encode(bytes); // 43자
        let challenge = challenge_for(&verifier);
        PkcePair { verifier, challenge, method: "S256" }
    }
}

pub fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// 43자(서버 `state` 규칙 `^[A-Za-z0-9_-]{32,128}$`).
pub fn random_state() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc7636_appendix_b_vector() {
        // RFC 7636 Appendix B
        assert_eq!(challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn generated_pair_is_valid() {
        let pair = PkcePair::generate();
        assert!((43..=128).contains(&pair.verifier.len()));
        assert!(pair.verifier.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_eq!(pair.challenge, challenge_for(&pair.verifier));
        assert!(!format!("{pair:?}").contains(&pair.verifier));
        assert_ne!(PkcePair::generate().verifier, pair.verifier);
        // 서버 Start/Exchange 규칙: challenge 43자, verifier 43–128자 [A-Za-z0-9._~-], state 32–128자
        assert_eq!(pair.challenge.len(), 43);
        let state = random_state();
        assert!((32..=128).contains(&state.len()) && state.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }
}
