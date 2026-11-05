// Package stellar holds small XDR helpers for building and reading Soroban values.
package stellar

import (
	"encoding/hex"
	"fmt"
	"math/big"
	"sort"

	"github.com/stellar/go-stellar-sdk/strkey"
	"github.com/stellar/go-stellar-sdk/xdr"
)

func Sym(s string) xdr.ScVal {
	v := xdr.ScSymbol(s)
	return xdr.ScVal{Type: xdr.ScValTypeScvSymbol, Sym: &v}
}

func Str(s string) xdr.ScVal {
	v := xdr.ScString(s)
	return xdr.ScVal{Type: xdr.ScValTypeScvString, Str: &v}
}

func U32(n uint32) xdr.ScVal {
	v := xdr.Uint32(n)
	return xdr.ScVal{Type: xdr.ScValTypeScvU32, U32: &v}
}

func Bytes(b []byte) xdr.ScVal {
	v := xdr.ScBytes(append([]byte(nil), b...))
	return xdr.ScVal{Type: xdr.ScValTypeScvBytes, Bytes: &v}
}

func Void() xdr.ScVal { return xdr.ScVal{Type: xdr.ScValTypeScvVoid} }

func I128(n *big.Int) xdr.ScVal {
	// two's complement split into hi (signed) / lo (unsigned) 64-bit halves
	mod := new(big.Int).Lsh(big.NewInt(1), 128)
	u := new(big.Int).Set(n)
	if u.Sign() < 0 {
		u.Add(u, mod)
	}
	mask := new(big.Int).SetUint64(^uint64(0))
	lo := new(big.Int).And(u, mask).Uint64()
	hi := new(big.Int).Rsh(u, 64).Uint64()
	parts := xdr.Int128Parts{Hi: xdr.Int64(int64(hi)), Lo: xdr.Uint64(lo)}
	return xdr.ScVal{Type: xdr.ScValTypeScvI128, I128: &parts}
}

func Vec(items ...xdr.ScVal) xdr.ScVal {
	v := xdr.ScVec(items)
	p := &v
	return xdr.ScVal{Type: xdr.ScValTypeScvVec, Vec: &p}
}

func Map(entries ...xdr.ScMapEntry) xdr.ScVal {
	m := xdr.ScMap(entries)
	p := &m
	return xdr.ScVal{Type: xdr.ScValTypeScvMap, Map: &p}
}

// Struct encodes a #[contracttype] struct: a map with symbol keys in sorted order.
func Struct(fields map[string]xdr.ScVal) xdr.ScVal {
	keys := make([]string, 0, len(fields))
	for k := range fields {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	entries := make([]xdr.ScMapEntry, 0, len(keys))
	for _, k := range keys {
		entries = append(entries, xdr.ScMapEntry{Key: Sym(k), Val: fields[k]})
	}
	return Map(entries...)
}

// Enum encodes a #[contracttype] enum variant: vec[symbol(name), ...values].
func Enum(variant string, values ...xdr.ScVal) xdr.ScVal {
	return Vec(append([]xdr.ScVal{Sym(variant)}, values...)...)
}

func ScAddress(address string) (xdr.ScAddress, error) {
	switch {
	case strkey.IsValidEd25519PublicKey(address):
		id, err := xdr.AddressToAccountId(address)
		if err != nil {
			return xdr.ScAddress{}, err
		}
		return xdr.ScAddress{Type: xdr.ScAddressTypeScAddressTypeAccount, AccountId: &id}, nil
	case strkey.IsValidContractAddress(address):
		raw, err := strkey.Decode(strkey.VersionByteContract, address)
		if err != nil {
			return xdr.ScAddress{}, err
		}
		var id xdr.ContractId
		copy(id[:], raw)
		return xdr.ScAddress{Type: xdr.ScAddressTypeScAddressTypeContract, ContractId: &id}, nil
	}
	return xdr.ScAddress{}, fmt.Errorf("not a G… or C… address: %q", address)
}

func Addr(address string) (xdr.ScVal, error) {
	a, err := ScAddress(address)
	if err != nil {
		return xdr.ScVal{}, err
	}
	return xdr.ScVal{Type: xdr.ScValTypeScvAddress, Address: &a}, nil
}

func MustAddr(address string) xdr.ScVal {
	v, err := Addr(address)
	if err != nil {
		panic(err)
	}
	return v
}

// Native converts an ScVal into plain Go values for JSON / inspection:
// maps -> map[string]any (symbol/string keys), vecs -> []any, ints -> *big.Int
// or uint32, addresses -> strkey strings, bytes -> hex strings.
func Native(v xdr.ScVal) any {
	if armMissing(v) {
		return nil // zero or malformed value, e.g. from a failed call
	}
	switch v.Type {
	case xdr.ScValTypeScvVoid:
		return nil
	case xdr.ScValTypeScvBool:
		return *v.B
	case xdr.ScValTypeScvU32:
		return uint32(*v.U32)
	case xdr.ScValTypeScvI32:
		return int32(*v.I32)
	case xdr.ScValTypeScvU64:
		return new(big.Int).SetUint64(uint64(*v.U64))
	case xdr.ScValTypeScvI64:
		return big.NewInt(int64(*v.I64))
	case xdr.ScValTypeScvI128:
		hi := big.NewInt(int64(v.I128.Hi))
		lo := new(big.Int).SetUint64(uint64(v.I128.Lo))
		return hi.Lsh(hi, 64).Add(hi, lo)
	case xdr.ScValTypeScvSymbol:
		return string(*v.Sym)
	case xdr.ScValTypeScvString:
		return string(*v.Str)
	case xdr.ScValTypeScvBytes:
		return hex.EncodeToString(*v.Bytes)
	case xdr.ScValTypeScvAddress:
		s, err := v.Address.String()
		if err != nil {
			return "<bad address>"
		}
		return s
	case xdr.ScValTypeScvVec:
		if v.Vec == nil || *v.Vec == nil {
			return []any{}
		}
		out := make([]any, 0, len(**v.Vec))
		for _, item := range **v.Vec {
			out = append(out, Native(item))
		}
		return out
	case xdr.ScValTypeScvMap:
		out := map[string]any{}
		if v.Map == nil || *v.Map == nil {
			return out
		}
		for _, e := range **v.Map {
			out[fmt.Sprint(Native(e.Key))] = Native(e.Val)
		}
		return out
	}
	return v.Type.String()
}

// armMissing reports whether the union arm for v.Type is nil.
func armMissing(v xdr.ScVal) bool {
	switch v.Type {
	case xdr.ScValTypeScvBool:
		return v.B == nil
	case xdr.ScValTypeScvU32:
		return v.U32 == nil
	case xdr.ScValTypeScvI32:
		return v.I32 == nil
	case xdr.ScValTypeScvU64:
		return v.U64 == nil
	case xdr.ScValTypeScvI64:
		return v.I64 == nil
	case xdr.ScValTypeScvI128:
		return v.I128 == nil
	case xdr.ScValTypeScvSymbol:
		return v.Sym == nil
	case xdr.ScValTypeScvString:
		return v.Str == nil
	case xdr.ScValTypeScvBytes:
		return v.Bytes == nil
	case xdr.ScValTypeScvAddress:
		return v.Address == nil
	}
	return false
}

// Field returns a struct field (symbol key) from an ScVal map.
func Field(v xdr.ScVal, name string) (xdr.ScVal, bool) {
	if v.Type != xdr.ScValTypeScvMap || v.Map == nil || *v.Map == nil {
		return xdr.ScVal{}, false
	}
	for _, e := range **v.Map {
		if e.Key.Type == xdr.ScValTypeScvSymbol && string(*e.Key.Sym) == name {
			return e.Val, true
		}
	}
	return xdr.ScVal{}, false
}
