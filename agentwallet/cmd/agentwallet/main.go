// agentwallet: a multi-tenant wallet service for AI agents on Stellar testnet.
// Users sign in with their wallet; each gets an OpenZeppelin smart account
// that only their wallet controls; agents get rules on it with on-chain
// spending limits, and pay through MCP or the built-in chat.
//
//	agentwallet init            create the sealed keystore (relayers + SEP-10 key); prints a new master key if none is set
//	agentwallet serve           HTTP API + UI + MCP on $LISTEN
//	agentwallet mcp             MCP over stdio for the agent whose API key is in $AGENTWALLET_API_KEY
//	agentwallet account <G…>    print a user's smart account address and state
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/config"
	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/db"
	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/server"
	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/vault"
	"github.com/ArbitrageScanner/stellar-agent-wallet/agentwallet/internal/wallet"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("agentwallet ")
	if len(os.Args) < 2 {
		usage()
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	switch os.Args[1] {
	case "init":
		initKeystore()
		return
	case "serve", "mcp", "account":
	default:
		usage()
	}

	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}
	w := wallet.New(cfg.Wallet)
	switch os.Args[1] {
	case "account":
		if len(os.Args) < 3 {
			usage()
		}
		addr, err := w.AccountAddress(os.Args[2])
		check(err)
		ok, err := w.AccountExists(ctx, addr)
		check(err)
		out := map[string]any{"owner": os.Args[2], "account": addr, "deployed": ok}
		if ok {
			ov, err := w.ForAccount(addr, 0, nil).Overview(ctx)
			check(err)
			out["overview"] = ov
		}
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(out)
		return
	}

	store, err := db.Open(cfg.DBFile)
	if err != nil {
		log.Fatal(err)
	}
	defer store.Close()
	srv := server.New(cfg, w, store)
	switch os.Args[1] {
	case "serve":
		err = srv.Run(ctx)
	case "mcp":
		log.SetOutput(os.Stderr) // stdout belongs to the MCP protocol
		key := os.Getenv("AGENTWALLET_API_KEY")
		if key == "" {
			log.Fatal("set AGENTWALLET_API_KEY to the agent's API key")
		}
		err = srv.RunStdioMCP(ctx, key)
	}
	if err != nil {
		log.Fatal(err)
	}
}

func initKeystore() {
	cfg, err := config.Base()
	if err != nil {
		log.Fatal(err)
	}
	v, err := vault.FromEnv()
	if err != nil {
		key := vault.NewKey()
		fmt.Fprintf(os.Stderr, "No MASTER_KEY set; generated a new one. Store it in a secret manager and export it:\n\n  export MASTER_KEY=%s\n\nIt is not written anywhere.\n\n", key)
		_ = os.Setenv("MASTER_KEY", key)
		if v, err = vault.FromEnv(); err != nil {
			log.Fatal(err)
		}
	}
	if _, err := os.Stat(cfg.KeystoreFile); err == nil {
		if _, err := config.LoadKeystore(v, cfg.KeystoreFile); err != nil {
			log.Fatalf("%s exists but does not open with this master key: %v", cfg.KeystoreFile, err)
		}
		log.Printf("%s already exists and opens with this master key; nothing to do", cfg.KeystoreFile)
		return
	}
	n := cfg.RelayersCount
	if n < 1 {
		n = 3
	}
	ks, err := config.NewKeystore(n, cfg.Friendbot, log.Printf)
	if err != nil {
		log.Fatal(err)
	}
	if err := config.SaveKeystore(v, cfg.KeystoreFile, ks); err != nil {
		log.Fatal(err)
	}
	log.Printf("wrote sealed keystore %s (%d relayers)", cfg.KeystoreFile, n)
}

func check(err error) {
	if err != nil {
		log.Fatal(err)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: agentwallet init | serve | mcp | account <G…>")
	os.Exit(2)
}
