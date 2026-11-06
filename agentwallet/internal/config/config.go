// Package config loads settings, the shared contract deployment and the
// sealed keystore.
//
// Nothing secret is read from plaintext files: the master key comes from
// MASTER_KEY / MASTER_KEY_FILE, and everything else secret lives in the
// vault-sealed keystore (service keys) or database (agent keys).
package config

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"strconv"

	"github.com/stellar/go-stellar-sdk/keypair"
	"github.com/stellar/go-stellar-sdk/network"
	"github.com/stellar/go-stellar-sdk/txnbuild"
	"github.com/stellar/go-stellar-sdk/xdr"

	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/vault"
	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/wallet"
)

const usdcIssuer = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"

// accountWasmHash is contracts/account (OZ stellar-accounts 0.8.0) as built
// in this repo and uploaded to testnet.
const accountWasmHash = "b5e71697395ba05e541aa859bfecca573b67e15617427892c8dcf4a10032f17f"

type App struct {
	Wallet      wallet.Config
	AccountWasm xdr.Hash
	Vault       *vault.Vault
	WebAuth     *keypair.Full

	Listen            string
	PublicURL         string
	HomeDomain        string // SEP-10 home + web auth domain (host of PublicURL)
	CookieSecure      bool
	DBFile            string
	KeystoreFile      string
	LLMKey            string // OpenAI-compatible chat completions API (OpenRouter by default)
	LLMURL            string
	DefaultModel      string
	ApprovalThreshold string
	DemoPayee         string
	PeriodLedgers     uint32
	DevWallet         bool
	Friendbot         string
	RelayersCount     int
	TrustProxy        bool // take the client IP from X-Forwarded-For (only behind a reverse proxy)
	Limits            Limits
}

// Limits are the abuse guards. 0 disables a limit.
type Limits struct {
	ChatMaxChars      int // characters per chat message
	ChatHistory       int // messages of history sent to the model per turn
	LLMMaxTokens      int // max_tokens per model reply
	ChatDailyWallet   int // chat messages per wallet per UTC day
	ChatDailyIP       int // chat messages per IP per UTC day
	LLMDailyCalls     int // model calls per UTC day for the whole service
	ChatConcurrent    int // chat answers streaming at once per wallet
	PendingOps        int // unsigned ops per user
	DeploysPerIPDay   int // account deploys per IP per UTC day
	OwnerOpsPerHour   int // prepared owner/user ops per wallet per hour
	AgentsPerUser     int
	KeysPerAgent      int // active API keys per agent
	MCPCallsPerMinute int // tool calls per agent per minute (MCP and chat)
}

func env(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}

// Base loads everything except the keystore (used by `init`).
func Base() (*App, error) {
	deployFile := env("DEPLOYMENT_FILE", "../deployments/testnet.json")
	var deploy struct {
		Accounts  map[string]string `json:"accounts"`
		Contracts map[string]string `json:"contracts"`
	}
	if err := readJSON(deployFile, &deploy); err != nil {
		return nil, err
	}
	c := deploy.Contracts
	pub := env("PUBLIC_URL", "http://localhost:8090")
	u, err := url.Parse(pub)
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("PUBLIC_URL %q is not a URL", pub)
	}
	app := &App{
		Wallet: wallet.Config{
			RPCURL:           env("RPC_URL", "https://soroban-testnet.stellar.org"),
			Passphrase:       env("NETWORK_PASSPHRASE", network.TestNetworkPassphrase),
			Explorer:         env("EXPLORER_URL", "https://stellar.expert/explorer/testnet"),
			Verifier:         env("VERIFIER", c["ed25519_verifier"]),
			Policy:           env("SPENDING_LIMIT_POLICY", c["spending_limit_policy"]),
			USDC:             env("USDC_SAC", c["usdc_sac"]),
			USDCAsset:        txnbuild.CreditAsset{Code: "USDC", Issuer: env("USDC_ISSUER", usdcIssuer)},
			RecordRejections: env("RECORD_REJECTIONS", "true") == "true",
		},
		Listen:            env("LISTEN", ":8090"),
		PublicURL:         pub,
		HomeDomain:        u.Host,
		CookieSecure:      env("COOKIE_SECURE", strconv.FormatBool(u.Scheme == "https")) == "true",
		DBFile:            env("DB_FILE", "./data/agentwallet.db"),
		KeystoreFile:      env("KEYSTORE_FILE", "./data/keystore.enc"),
		LLMKey:            env("LLM_API_KEY", os.Getenv("OPENROUTER_API_KEY")),
		LLMURL:            env("LLM_BASE_URL", env("OPENROUTER_URL", "https://openrouter.ai/api/v1")),
		DefaultModel:      env("MODEL", "openai/gpt-4o-mini"),
		ApprovalThreshold: env("APPROVAL_THRESHOLD", "2"),
		DemoPayee:         env("DEMO_PAYEE", deploy.Accounts["payee"]),
		PeriodLedgers:     uint32(atoi(env("PERIOD_LEDGERS", "17280"))),
		DevWallet:         env("DEV_WALLET", "false") == "true",
		Friendbot:         env("FRIENDBOT_URL", "https://friendbot.stellar.org"),
		RelayersCount:     atoi(env("RELAYERS", "3")),
		TrustProxy:        env("TRUST_PROXY", "false") == "true",
		Limits: Limits{
			ChatMaxChars:      atoi(env("CHAT_MAX_CHARS", "4000")),
			ChatHistory:       atoi(env("CHAT_HISTORY_MESSAGES", "30")),
			LLMMaxTokens:      atoi(env("LLM_MAX_TOKENS", "1024")),
			ChatDailyWallet:   atoi(env("CHAT_DAILY_PER_WALLET", "50")),
			ChatDailyIP:       atoi(env("CHAT_DAILY_PER_IP", "150")),
			LLMDailyCalls:     atoi(env("LLM_DAILY_CALLS", "5000")),
			ChatConcurrent:    atoi(env("CHAT_CONCURRENT_PER_WALLET", "3")),
			PendingOps:        atoi(env("PENDING_OPS_PER_USER", "20")),
			DeploysPerIPDay:   atoi(env("DEPLOYS_PER_IP_DAY", "10")),
			OwnerOpsPerHour:   atoi(env("OWNER_OPS_PER_HOUR", "30")),
			AgentsPerUser:     atoi(env("AGENTS_PER_USER", "10")),
			KeysPerAgent:      atoi(env("KEYS_PER_AGENT", "5")),
			MCPCallsPerMinute: atoi(env("MCP_CALLS_PER_MINUTE", "120")),
		},
	}
	h, err := hex.DecodeString(env("ACCOUNT_WASM_HASH", accountWasmHash))
	if err != nil || len(h) != 32 {
		return nil, errors.New("ACCOUNT_WASM_HASH must be 32 bytes hex")
	}
	copy(app.AccountWasm[:], h)
	w := app.Wallet
	for name, v := range map[string]string{"VERIFIER": w.Verifier, "SPENDING_LIMIT_POLICY": w.Policy, "USDC_SAC": w.USDC} {
		if v == "" {
			return nil, fmt.Errorf("missing %s: set it or provide %s", name, deployFile)
		}
	}
	return app, nil
}

// Load also opens the vault and the sealed keystore.
func Load() (*App, error) {
	app, err := Base()
	if err != nil {
		return nil, err
	}
	if app.Vault, err = vault.FromEnv(); err != nil {
		return nil, err
	}
	ks, err := LoadKeystore(app.Vault, app.KeystoreFile)
	if err != nil {
		return nil, err
	}
	for _, s := range ks.Relayers {
		kp, err := keypair.ParseFull(s)
		if err != nil {
			return nil, fmt.Errorf("keystore relayer: %w", err)
		}
		app.Wallet.Relayers = append(app.Wallet.Relayers, kp)
	}
	app.Wallet.Relayer = app.Wallet.Relayers[0]
	if app.WebAuth, err = keypair.ParseFull(ks.WebAuth); err != nil {
		return nil, fmt.Errorf("keystore web auth: %w", err)
	}
	return app, nil
}

// readJSON decodes path into v; a missing file is fine (env vars may cover it).
func readJSON(path string, v any) error {
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := json.Unmarshal(raw, v); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	return nil
}

func atoi(s string) int {
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0
	}
	return n
}
