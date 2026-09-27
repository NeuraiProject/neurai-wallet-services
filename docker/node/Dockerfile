# ── Stage 1: Build ─────────────────────────────────────────────────────────
FROM debian:12 AS builder

ARG DEBIAN_FRONTEND=noninteractive
ARG BRANCH=DePIN-Test

RUN apt-get update && apt-get install -y --no-install-recommends \
    autoconf \
    automake \
    autotools-dev \
    binutils \
    bison \
    bsdmainutils \
    build-essential \
    ca-certificates \
    cmake \
    curl \
    git \
    gnupg \
    libffi-dev \
    libfontconfig1 \
    libfreetype6 \
    libssl-dev \
    libtool \
    libxcb-cursor0 \
    libxcb-icccm4 \
    libxcb-image0 \
    libxcb-keysyms1 \
    libxcb-randr0 \
    libxcb-render-util0 \
    libxcb-shape0 \
    libxcb-sync1 \
    libxcb-xfixes0 \
    libxcb-xkb1 \
    libxkbcommon0 \
    libxkbcommon-x11-0 \
    meson \
    ninja-build \
    pkg-config \
    python3 \
    unzip \
    wget \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /root

# Exact commit of BRANCH to build (empty = branch head). Docker caches the
# clone layer by its command text, so with only a branch name a rebuild keeps
# serving whatever the branch pointed to the first time — for the reset testnet
# that is a node with the previous genesis. The testnet compose pins the
# audited commit through NODE_SOURCE_COMMIT; changing it invalidates the cache
# from here on (declared late so the apt layer above stays cached).
ARG SOURCE_COMMIT=

RUN git clone --branch ${BRANCH} --single-branch \
    https://github.com/NeuraiProject/Neurai.git \
 && if [ -n "${SOURCE_COMMIT}" ]; then git -C Neurai checkout --detach "${SOURCE_COMMIT}"; fi \
 && git -C Neurai rev-parse HEAD > /root/neurai-source-commit \
 && echo "Building Neurai ${BRANCH} at $(cat /root/neurai-source-commit)"

WORKDIR /root/Neurai/depends

# NO_QT=1 — skip building Qt and its transitive deps in depends/. Saves
# ~30-50 min off the build. ZMQ is still built by depends/ as usual and
# linked statically into neuraid.
# FALLBACK_DOWNLOAD_PATH — depends tries each package's own URL first and uses
# this mirror only when that fails; every file is still checked against the
# sha256 pinned in depends/packages. Needed in practice for ccache-3.3.4, whose
# only source (samba.org) has been unreachable and aborted the build.
RUN make HOST=x86_64-pc-linux-gnu NO_QT=1 \
      FALLBACK_DOWNLOAD_PATH=https://bitcoincore.org/depends-sources \
      -j$(nproc)

WORKDIR /root/Neurai

RUN contrib/install_db4.sh ../

ENV BDB_PREFIX=/root/db4

RUN ./autogen.sh

RUN CONFIG_SITE=$PWD/depends/x86_64-pc-linux-gnu/share/config.site \
    ./configure \
      --prefix=$PWD/depends/x86_64-pc-linux-gnu \
      --disable-shared \
      --disable-maintainer-mode \
      --disable-tests \
      --disable-bench \
      --without-gui \
      --with-pic \
      LDFLAGS="-L${BDB_PREFIX}/lib/" \
      CPPFLAGS="-I${BDB_PREFIX}/include/"

RUN make -j$(nproc)

# ── Stage 2: Runtime ───────────────────────────────────────────────────────
FROM debian:12

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ARG BRANCH=DePIN-Test
ARG SOURCE_COMMIT=
# Lets an operator check which source a running node was built from without
# trusting the tag: `docker image inspect` (labels) or, inside the container,
# `cat /usr/local/share/neurai/source-commit` (resolved full SHA).
LABEL org.opencontainers.image.source="https://github.com/NeuraiProject/Neurai" \
      org.opencontainers.image.ref.name="${BRANCH}" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}"

COPY --from=builder /root/Neurai/src/neuraid     /usr/local/bin/neuraid
COPY --from=builder /root/Neurai/src/neurai-cli  /usr/local/bin/neurai-cli
COPY --from=builder /root/neurai-source-commit   /usr/local/share/neurai/source-commit
COPY entrypoint.sh /usr/local/bin/entrypoint.sh

RUN chmod +x /usr/local/bin/entrypoint.sh

VOLUME ["/data"]

EXPOSE 19100 19101 28332

ENTRYPOINT ["entrypoint.sh"]
