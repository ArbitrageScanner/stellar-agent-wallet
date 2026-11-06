package db

import (
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTokensStoredHashed(t *testing.T) {
	d, err := Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if err := d.UpsertUser("GUSER", "CACCT"); err != nil {
		t.Fatal(err)
	}
	sess, err := d.CreateSession("GUSER", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if addr, err := d.SessionAddress(sess); err != nil || addr != "GUSER" {
		t.Fatalf("session lookup: %v %q", err, addr)
	}
	r := uint32(1)
	if err := d.CreateAgent(Agent{ID: "ag_1", Owner: "GUSER", Name: "bot", PublicKey: "GAGENT", SecretEnc: []byte{1}, RuleID: &r, Status: "active"}); err != nil {
		t.Fatal(err)
	}
	key, prefix, err := d.CreateAPIKey("ag_1")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(key, prefix) {
		t.Fatalf("prefix %q not a prefix of the key", prefix)
	}
	if a, err := d.AgentByAPIKey(key); err != nil || a.ID != "ag_1" {
		t.Fatalf("api key lookup: %v %v", err, a.ID)
	}

	// nothing in the database equals a raw token
	for _, q := range []string{`SELECT hash FROM sessions`, `SELECT hash FROM api_keys`} {
		var stored string
		if err := d.sql.QueryRow(q).Scan(&stored); err != nil {
			t.Fatal(err)
		}
		if stored == sess || stored == key || strings.Contains(stored, "awk_") || strings.Contains(stored, "aws_") {
			t.Fatalf("%s stores a raw token", q)
		}
	}

	if ok, _ := d.RevokeAPIKey("ag_1", prefix); !ok {
		t.Fatal("revoke failed")
	}
	if _, err := d.AgentByAPIKey(key); err != ErrNotFound {
		t.Fatal("revoked key still works")
	}
	if err := d.SetAgentStatus("ag_1", "revoked"); err != nil {
		t.Fatal(err)
	}
	k2, _, _ := d.CreateAPIKey("ag_1")
	if _, err := d.AgentByAPIKey(k2); err != ErrNotFound {
		t.Fatal("revoked agent's key still works")
	}
	if err := d.DeleteSession(sess); err != nil {
		t.Fatal(err)
	}
	if _, err := d.SessionAddress(sess); err != ErrNotFound {
		t.Fatal("deleted session still valid")
	}
}

func TestDailyUse(t *testing.T) {
	d, err := Open(filepath.Join(t.TempDir(), "u.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	for i := 1; i <= 3; i++ {
		if n, ok, err := d.Use("chat:G1", 3); err != nil || !ok || n != i {
			t.Fatalf("use %d: n=%d ok=%v err=%v", i, n, ok, err)
		}
	}
	if _, ok, _ := d.Use("chat:G1", 3); ok {
		t.Fatal("4th use allowed over a limit of 3")
	}
	if d.Used("chat:G1") != 3 {
		t.Fatalf("used = %d", d.Used("chat:G1"))
	}
	if _, ok, _ := d.Use("chat:G2", 3); !ok {
		t.Fatal("keys are independent")
	}
	if _, ok, _ := d.Use("x", 0); !ok {
		t.Fatal("limit 0 means unlimited")
	}
}
