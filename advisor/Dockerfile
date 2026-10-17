# Fleet Advisor: the stack's server-owned host whose only job is `cxx daemon run`.
# python3 runs the bootstrap; git and curl serve the advisor's own tooling.
# Advisor sessions are ordinary daemon sessions; see docs/interface-api.md#fleet-advisor.
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git python3 tini procps \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 --shell /bin/sh advisor \
 && install -d -o advisor -g advisor /work

COPY --chmod=0755 entrypoint.sh /usr/local/bin/advisor-entrypoint
COPY --chmod=0755 bootstrap.py /usr/local/bin/advisor-bootstrap.py

USER advisor
ENV HOME=/home/advisor
WORKDIR /work
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/advisor-entrypoint"]
