# Frozen synthetic identity vectors

`official-identity-vectors.json` contains only the eight `identityVectors`
from the existing phase021 acceptance artifact
`docs/echo-executor-021-examples.json` in the original workspace.

Original artifact SHA256:
`9334f9227085fe0a9fce8b0e966dc149aee05893fcc495e3ebe1761a7c2e972b`.

The input identities are declared synthetic. The private four-ID redaction
mapping was checked in memory and matched zero occurrences in the selected
vectors. No source identity, expected digest, preimage or assertion was
recomputed or invented. The rest of the old artifact is not included.

The codec test continues to assert both the frozen expected results and the
independent reference derivation. This checked-in fixture replaces a relative
read outside the repository.
