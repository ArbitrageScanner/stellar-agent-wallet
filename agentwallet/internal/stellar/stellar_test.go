package stellar

import (
	"github.com/stellar/go-stellar-sdk/xdr"
	"math/big"
	"testing"
)

func TestAmountRoundTrip(t *testing.T) {
	for in, stroops := range map[string]int64{"1": 10_000_000, "0.5": 5_000_000, "10.0000001": 100_000_001, "0.0000001": 1, "0": 0} {
		n, err := ParseAmount(in)
		if err != nil || n.Int64() != stroops {
			t.Fatalf("ParseAmount(%q) = %v, %v; want %d", in, n, err, stroops)
		}
		want := in
		if in == "10.0000001" || in == "0.0000001" || in == "1" || in == "0.5" || in == "0" {
			want = in
		}
		if got := FormatAmount(n); got != want {
			t.Fatalf("FormatAmount(%d) = %q, want %q", stroops, got, want)
		}
	}
	for _, bad := range []string{"", "abc", "1.00000001", "-", "1e3", "+1"} {
		if _, err := ParseAmount(bad); err == nil {
			t.Fatalf("ParseAmount(%q) accepted", bad)
		}
	}
	if got := FormatAmount(big.NewInt(-15_000_000)); got != "-1.5" {
		t.Fatalf("negative: %q", got)
	}
}

func TestI128RoundTrip(t *testing.T) {
	huge, _ := new(big.Int).SetString("170141183460469231731687303715884105727", 10) // 2^127-1
	for _, n := range []*big.Int{big.NewInt(0), big.NewInt(50_000_000), big.NewInt(-1), huge, new(big.Int).Neg(huge)} {
		got := Native(I128(n)).(*big.Int)
		if got.Cmp(n) != 0 {
			t.Fatalf("i128 %s -> %s", n, got)
		}
	}
}

func TestStructSortsKeys(t *testing.T) {
	v := Struct(map[string]xdr.ScVal{"signature_payload": U32(3), "account": U32(1), "context_rule_ids": U32(2)})
	m := **v.Map
	if string(*m[0].Key.Sym) != "account" || string(*m[1].Key.Sym) != "context_rule_ids" || string(*m[2].Key.Sym) != "signature_payload" {
		t.Fatalf("keys not sorted: %v", Native(v))
	}
}

func TestNativeZeroValueDoesNotPanic(t *testing.T) {
	if got := Native(xdr.ScVal{}); got != nil {
		t.Fatalf("zero ScVal: got %v", got)
	}
}
