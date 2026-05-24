FROM python:3.12-slim

WORKDIR /app

# INSTALL CURL FOR HEALTHCHECK
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

# CACHE DEPENDENCY LAYER BEFORE CODE CHANGES
COPY app/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ .

EXPOSE 5010

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:5010/api/health || exit 1

# ALLOW WORKER/THREAD COUNT OVERRIDE VIA ENV
CMD ["sh", "-c", "gunicorn --bind 0.0.0.0:5010 --workers ${WORKERS:-1} --threads ${THREADS:-2} --timeout 120 --access-logfile - --error-logfile - app:app"]
