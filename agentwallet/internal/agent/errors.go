package agent

import "github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/wallet"

func invalidArgs(err error) *wallet.Error {
	return &wallet.Error{Code: "invalid_argument", Message: "tool arguments are not valid JSON: " + err.Error()}
}
