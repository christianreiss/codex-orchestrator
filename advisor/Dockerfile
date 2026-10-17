# Fleet Advisor host: a registered fleet host whose only job is `cxx daemon run`.
# Advisor sessions are ordinary daemon sessions; see docs/interface-api.md#fleet-advisor.
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git tini procps \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 --shell /bin/sh advisor \
 && install -d -o advisor -g advisor /work

COPY --chmod=0755 entrypoint.sh /usr/local/bin/advisor-entrypoint

USER advisor
ENV HOME=/home/advisor
WORKDIR /work
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/advisor-entrypoint"]
