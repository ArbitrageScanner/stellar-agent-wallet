package config

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/stellar/go-stellar-sdk/keypair"

	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/vault"
)

const keystoreContext = "agentwallet/keystore/v1"

// Keystore holds the service's own secrets. On disk it exists only sealed by
// the vault (KEYSTORE_FILE); it is never written in plaintext.
type Keystore struct {
	Relayers []string `json:"relayers"` // fee-paying channel accounts
	WebAuth  string   `json:"web_auth"` // SEP-10 challenge signing key
}

func LoadKeystore(v *vault.Vault, path string) (*Keystore, error) {
	sealed, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("keystore %s: %w (create it with `agentwallet init`)", path, err)
	}
	raw, err := v.Open(sealed, keystoreContext)
	if err != nil {
		return nil, fmt.Errorf("keystore %s: %w", path, err)
	}
	var ks Keystore
	if err := json.Unmarshal(raw, &ks); err != nil {
		return nil, err
	}
	if len(ks.Relayers) == 0 || ks.WebAuth == "" {
		return nil, fmt.Errorf("keystore %s is incomplete", path)
	}
	return &ks, nil
}

func SaveKeystore(v *vault.Vault, path string, ks *Keystore) error {
	raw, err := json.Marshal(ks)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, v.Seal(raw, keystoreContext), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// NewKeystore generates n relayers and a web-auth key, and funds the relayers
// with friendbot (testnet).
func NewKeystore(n int, friendbot string, logf func(string, ...any)) (*Keystore, error) {
	ks := &Keystore{}
	for i := 0; i < n; i++ {
		kp, _ := keypair.Random()
		if err := fund(friendbot, kp.Address()); err != nil {
			return nil, fmt.Errorf("friendbot %s: %w", kp.Address(), err)
		}
		logf("relayer %d: %s funded", i+1, kp.Address())
		ks.Relayers = append(ks.Relayers, kp.Seed())
	}
	web, _ := keypair.Random()
	ks.WebAuth = web.Seed()
	logf("web auth (SEP-10) signing key: %s", web.Address())
	return ks, nil
}

func fund(friendbot, address string) error {
	c := &http.Client{Timeout: 60 * time.Second}
	resp, err := c.Get(friendbot + "?addr=" + url.QueryEscape(address))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		// friendbot answers errors as problem+json; surface its detail
		var p struct {
			Title  string `json:"title"`
			Detail string `json:"detail"`
		}
		_ = json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&p)
		if msg := strings.TrimSpace(p.Detail + " " + p.Title); msg != "" {
			return fmt.Errorf("HTTP %d: %s", resp.StatusCode, msg)
		}
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}

// Fund is exposed for the dev wallet.
func Fund(friendbot, address string) error { return fund(friendbot, address) }
