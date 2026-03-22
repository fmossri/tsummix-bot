# Grafana (Tsummix)

- **`provisioning/datasources/datasources.yml`** — Prometheus (`uid: prometheus`) and Loki (`uid: loki`).
- **`provisioning/dashboards/dashboards.yml`** — File provider; loads JSON from **`provisioning/dashboards/json/`**.
- **`provisioning/dashboards/json/tsummix-overview.json`** — Overview dashboard: **PromQL** (Prometheus) + **LogQL** (Loki) for Promtail jobs `docker` and `tsummix-files` (see `docker/promtail/promtail-config.yaml`). With `LOG_TO_STDOUT=false`, Docker log panels may be quiet while file-based panels show traffic.

**After you change YAML or JSON** under this folder, restart the Grafana container (or `docker compose … up -d` again) so Grafana reloads provisioning.

**Grafana newcomers:** Grafana stores UI state (preferences, sometimes merged datasource records) in the **`grafana-data`** Docker volume. On a normal first-time setup you do **not** need to touch it. Only if you see weird duplicate datasources or dashboards that ignore your updated YAML might you remove the volume once and recreate the stack so Grafana starts from a clean slate. Until something looks wrong, you can ignore that.
