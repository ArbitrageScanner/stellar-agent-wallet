// Package vault encrypts secrets at rest with AES-256-GCM under a master key
// that only ever comes from the environment or a mounted secret file.
//
// Every sealed value is bound to a context string (AAD), e.g. the agent id,
// so a ciphertext copied into another row does not decrypt.
package vault

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"strings"
)

const version byte = 1

type Vault struct{ aead cipher.AEAD }

// New builds a vault from a 32-byte key.
func New(key []byte) (*Vault, error) {
	if len(key) != 32 {
		return nil, fmt.Errorf("master key must be 32 bytes, got %d", len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Vault{aead: aead}, nil
}

// FromEnv reads the base64 master key from MASTER_KEY, or from the file named
// by MASTER_KEY_FILE (e.g. a Docker/K8s secret mount).
func FromEnv() (*Vault, error) {
	b64 := strings.TrimSpace(os.Getenv("MASTER_KEY"))
	if b64 == "" {
		if f := os.Getenv("MASTER_KEY_FILE"); f != "" {
			raw, err := os.ReadFile(f)
			if err != nil {
				return nil, fmt.Errorf("MASTER_KEY_FILE: %w", err)
			}
			b64 = strings.TrimSpace(string(raw))
		}
	}
	if b64 == "" {
		return nil, errors.New("no master key: set MASTER_KEY or MASTER_KEY_FILE (generate one with `agentwallet init`)")
	}
	key, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, fmt.Errorf("master key is not base64: %w", err)
	}
	return New(key)
}

// NewKey returns a fresh random base64 master key.
func NewKey() string {
	k := make([]byte, 32)
	_, _ = rand.Read(k)
	return base64.StdEncoding.EncodeToString(k)
}

// Seal encrypts plaintext bound to context: version || nonce || ciphertext.
func (v *Vault) Seal(plaintext []byte, context string) []byte {
	nonce := make([]byte, v.aead.NonceSize())
	_, _ = rand.Read(nonce)
	out := append([]byte{version}, nonce...)
	return v.aead.Seal(out, nonce, plaintext, []byte(context))
}

// Open decrypts a value sealed with the same context.
func (v *Vault) Open(sealed []byte, context string) ([]byte, error) {
	n := v.aead.NonceSize()
	if len(sealed) < 1+n || sealed[0] != version {
		return nil, errors.New("vault: malformed ciphertext")
	}
	pt, err := v.aead.Open(nil, sealed[1:1+n], sealed[1+n:], []byte(context))
	if err != nil {
		return nil, errors.New("vault: cannot decrypt (wrong master key or context)")
	}
	return pt, nil
}
