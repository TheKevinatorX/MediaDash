###################
# MEDIADASH IMAGE #
###################

FROM python:3.12-slim

# VERSION METADATA BAKED IN AT BUILD TIME
ARG MEDIADASH_VERSION=
ARG MEDIADASH_IMAGE_TAG=
ARG MEDIADASH_GIT_SHA=

ENV MEDIADASH_VERSION=${MEDIADASH_VERSION}
ENV MEDIADASH_IMAGE_TAG=${MEDIADASH_IMAGE_TAG}
ENV MEDIADASH_GIT_SHA=${MEDIADASH_GIT_SHA}
ENV MEDIADASH_IMAGE=ghcr.io/thekevinatorx/mediadash:${MEDIADASH_IMAGE_TAG}

WORKDIR /app

# INSTALL CURL FOR HEALTHCHECK AND FFMPEG FOR FILE SCANNING
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ffmpeg && \
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
