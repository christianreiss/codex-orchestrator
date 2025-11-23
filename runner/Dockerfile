FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl jq ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY runner/requirements.txt requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY runner/app.py runner/entrypoint.sh /app/
COPY bin/cdx /app/cdx

RUN chmod +x /app/entrypoint.sh /app/cdx

ENV PYTHONUNBUFFERED=1
EXPOSE 8080

ENTRYPOINT ["/app/entrypoint.sh"]
