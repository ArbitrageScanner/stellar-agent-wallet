package config

import "testing"

// Existing keystores are sealed with this context; changing it locks them.
func TestKeystoreContextIsStable(t *testing.T) {
	if keystoreContext != "agentwallet/keystore/v1" {
		t.Fatalf("keystore context changed to %q", keystoreContext)
	}
}
