# ADR-11: Per-publisher signing keys under a workspace root

Status: accepted as the plan's default; confirm in spec v2.1

`self` and `authors:[...]` worker trust policies need to tell authors apart, which one workspace key
cannot. Each publisher gets an Ed25519 key pair; the workspace root key signs a certificate binding the
publisher's public key to their user ID. Packages are signed with the publisher key and carry the
certificate. Workers verify the certificate chain to the workspace root, then the package signature and
hash, then apply their trust policy to the publisher ID.
