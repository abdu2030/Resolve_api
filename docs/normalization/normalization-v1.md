# Normalization Policy: normalization-v1

Resolve preserves raw input and stores normalized values as derived data.

- Text uses Unicode NFKC, trimmed outer whitespace, and field-safe whitespace collapsing.
- Name comparison forms use lowercase text and conservative punctuation handling.
- Email normalization preserves the local part and lowercases the domain.
- Email normalization does not remove dots or plus-tags.
- Phone normalization uses country context to derive E.164-style values.
- Failed phone parsing produces no normalized phone evidence; it does not fabricate a value.
- Company normalization retains legal suffix information as a separate signal.
- Domain normalization lowercases the host and removes a scheme, one leading `www.`, and a trailing dot.
- Address normalization works by component and retains distinctions between locations.

Week 1 Day 5 will implement these rules. Any semantic change requires a new normalization version and tests.
