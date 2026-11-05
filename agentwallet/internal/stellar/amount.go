package stellar

import (
	"fmt"
	"math/big"
	"regexp"
	"strings"
)

// Decimals is the precision of Stellar classic assets and their SAC wrappers.
const Decimals = 7

var (
	unit     = big.NewInt(10_000_000)
	amountRe = regexp.MustCompile(`^[0-9]+(\.[0-9]+)?$`)
)

// ParseAmount turns a non-negative decimal string ("1.5") into stroops (15000000).
func ParseAmount(s string) (*big.Int, error) {
	s = strings.TrimSpace(s)
	if !amountRe.MatchString(s) {
		return nil, fmt.Errorf("invalid amount %q: use a decimal like \"1\" or \"0.25\"", s)
	}
	whole, frac, hasFrac := strings.Cut(s, ".")
	if hasFrac && len(frac) > Decimals {
		return nil, fmt.Errorf("amount %q has more than %d decimals", s, Decimals)
	}
	frac += strings.Repeat("0", Decimals-len(frac))
	n, ok := new(big.Int).SetString(whole+frac, 10)
	if !ok {
		return nil, fmt.Errorf("invalid amount %q", s)
	}
	return n, nil
}

// FormatAmount turns stroops into a trimmed decimal string ("1.5").
func FormatAmount(n *big.Int) string {
	if n == nil {
		return "0"
	}
	neg := n.Sign() < 0
	abs := new(big.Int).Abs(n)
	q, r := new(big.Int).QuoRem(abs, unit, new(big.Int))
	out := q.String()
	if r.Sign() != 0 {
		out += "." + strings.TrimRight(fmt.Sprintf("%07s", r.String()), "0")
	}
	if neg {
		out = "-" + out
	}
	return out
}
