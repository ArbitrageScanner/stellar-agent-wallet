package vault

import (
	"bytes"
	"encoding/base64"
	"testing"
)

func TestSealOpen(t *testing.T) {
	key, _ := base64.StdEncoding.DecodeString(NewKey())
	v, err := New(key)
	if err != nil {
		t.Fatal(err)
	}
	secret := []byte("SBSECRETSEEDVALUE")
	sealed := v.Seal(secret, "agent:ag_1")
	if bytes.Contains(sealed, secret) {
		t.Fatal("plaintext visible in ciphertext")
	}
	got, err := v.Open(sealed, "agent:ag_1")
	if err != nil || !bytes.Equal(got, secret) {
		t.Fatalf("open: %v %q", err, got)
	}
	if _, err := v.Open(sealed, "agent:ag_2"); err == nil {
		t.Fatal("opened with a different context (row swap must fail)")
	}
	other, _ := base64.StdEncoding.DecodeString(NewKey())
	v2, _ := New(other)
	if _, err := v2.Open(sealed, "agent:ag_1"); err == nil {
		t.Fatal("opened with a different master key")
	}
	sealed[len(sealed)-1] ^= 1
	if _, err := v.Open(sealed, "agent:ag_1"); err == nil {
		t.Fatal("tampered ciphertext accepted")
	}
}
