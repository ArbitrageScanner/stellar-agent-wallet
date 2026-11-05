package wallet

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

func TestClassifyPrefersPolicyError(t *testing.T) {
	sim := `HostError: Error(Auth, InvalidAction)
Event log (newest first):
   0: [Diagnostic Event] topics:[error, Error(Auth, InvalidAction)], data:["failed account authentication with error", C..., Error(Contract, #3221)]
   1: [Failed Diagnostic Event (not emitted)] topics:[error, Error(Contract, #3221)]`
	if e := classify(sim); e.Code != "spending_limit_exceeded" {
		t.Fatalf("got %s", e.Code)
	}
	if e := classify(`{"topics":[{"symbol":"error"},{"error":{"contract":13}}]}`); e.Code != "payee_no_trustline" {
		t.Fatalf("json form: got %s", e.Code)
	}
	if e := classify("HostError: Error(Contract, #3002)"); e.Code != "agent_inactive" {
		t.Fatalf("got %s", e.Code)
	}
	if e := classify("something else"); e.Code != "tx_failed" {
		t.Fatalf("got %s", e.Code)
	}
}

// The salt decides every user's smart account address; changing it would
// silently move all accounts. Bump the version prefix only with a migration.
func TestAccountSaltIsStable(t *testing.T) {
	got := accountSalt("GB3WNAVXMVP6TDJ6CN3TVD5GO5LDZA52U7G44X76UQR7JAKXE6DAEBN6")
	if want := "4c666a6819c8de27f66713ecde012a38062cb0c76bd2a0fb256e79a97780a087"; fmt.Sprintf("%x", got[:]) != want {
		t.Fatalf("account salt changed: %x", got[:])
	}
}

func TestRetryTransientErrors(t *testing.T) {
	calls := 0
	v, err := retry(context.Background(), func() (int, error) {
		calls++
		if calls < 3 {
			return 0, errors.New("connection reset")
		}
		return 42, nil
	})
	if err != nil || v != 42 || calls != 3 {
		t.Fatalf("got %d, %v after %d calls", v, err, calls)
	}
	calls = 0
	if _, err := retry(context.Background(), func() (int, error) { calls++; return 0, errors.New("down") }); err == nil || calls != 3 {
		t.Fatalf("persistent failure: %v after %d calls", err, calls)
	}
}
