// crypto-helper.js — Optional AES-GCM encryption-at-rest for receipt images,
// with a key derived from the user's PIN via PBKDF2. The key lives only in
// memory for the session; it is never written to IndexedDB or localStorage.

let cryptoKey = null;
const SALT = new TextEncoder().encode('petty-cash-pwa-static-salt-v1');

export async function deriveKeyFromPin(pin) {
  if (!pin || !window.crypto?.subtle) {
    cryptoKey = null;
    return null;
  }
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  cryptoKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: SALT, iterations: 100000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  return cryptoKey;
}

export function hasCryptoKey() {
  return !!cryptoKey;
}

export function clearCryptoKey() {
  cryptoKey = null;
}

/**
 * Encrypts a base64 data-URL string. Returns an object with the
 * ciphertext (base64) and IV (base64), or the original string unchanged
 * if no key is available (encryption not enabled).
 */
export async function encryptBlob(dataUrlString) {
  if (!cryptoKey || !dataUrlString) return dataUrlString;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const cipherBuffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, enc.encode(dataUrlString));
  return {
    __encrypted: true,
    iv: bufferToBase64(iv),
    data: bufferToBase64(new Uint8Array(cipherBuffer))
  };
}

/**
 * Decrypts a payload produced by encryptBlob. Returns the original string,
 * or null if decryption fails (e.g. wrong/absent key).
 */
export async function decryptBlob(payload) {
  if (!payload) return null;
  if (typeof payload === 'string') return payload; // not encrypted
  if (!payload.__encrypted || !cryptoKey) return null;
  try {
    const iv = base64ToBuffer(payload.iv);
    const data = base64ToBuffer(payload.data);
    const plainBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, data);
    return new TextDecoder().decode(plainBuffer);
  } catch (err) {
    console.warn('Decryption failed:', err);
    return null;
  }
}

function bufferToBase64(buf) {
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function base64ToBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
