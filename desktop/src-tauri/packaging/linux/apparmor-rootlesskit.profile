abi <abi/4.0>,
include <tunables/global>

"/usr/lib/Speedwave/nerdctl-full/bin/rootlesskit" flags=(unconfined) {
  userns,

  include if exists <local/speedwave.rootlesskit>
}
