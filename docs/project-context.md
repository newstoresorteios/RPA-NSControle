# RPA-NSControle — contexto do projeto

## Objetivo
RPA que acessa o **Portal Importador** dos Correios, pesquisa remessas por rastreio, gera boleto bancário da taxa alfandegária e grava tudo no **mesmo Neon Postgres do NSControle** (sem banco separado do RPA). PDFs em `storage/boletos/` neste repo.

## Destino
`D:\Documents_Old\NewStore\deploy-prod\NSControle` — Neon via `DATABASE_URL` / `DATABASE_URL_UNPOOLED` (só em `.env.local` gitignored).

## Decisões fechadas (com Paulo)
- **Portal:** Portal Importador  
  URL: `https://portalimportador.correios.com.br/pages/pesquisarRemessaImportador/pesquisarRemessaImportador.jsf`
- **Fluxo:** login → pesquisa (**Aguardando Pagamento**) → **Path A** (`$`) ou **Path B** (sandwich → modal Pagar) → ciência → **Boleto Bancário** → pagfacil **Copiar código de barras** (+ PDF). Detecção: A primeiro; se “Pagamento em Processamento” / barcode vazio → B. `tax_paid` só quando pago.
- **Auth:** `CORREIOS_USER` + `CORREIOS_PASSWORD` (sem 2FA nesta fase). Senha **nunca** em docs/git
- **Store of record:** Neon NSControle — tabelas `ctl_correios_scrape_runs`, `ctl_correios_taxas`, `ctl_correios_boletos` com FK `order_id` → `ctl_orders.id`
- **Também atualiza** `ctl_orders.import_tax`, `tax_identified_at`, `tax_paid`, `notes_robot` (contabilidade / fila Financeiro > Taxas)
- **Fonte de rastreios:** preferir `ctl_orders.tracking_code` (planilha é espelho: Produto=rastreio, Taxa Paga, Observações Robô)
- **Agenda Path A/B:** GitHub Actions `correios-hourly.yml` a cada 15 min (crons `0/15/30/45` UTC); local via `npm run hourly`
- **Agenda status CWS:** GitHub Actions `correios-status-sync.yml` (mesmo padrão de cron) → `npm run status-sync` atualiza `ctl_orders.tracking_*` / `delivered` via API Rastro (sem Playwright)
- **Credenciais separadas:** Portal = `CORREIOS_USER` / `CORREIOS_PASSWORD`; CWS API = `CORREIOS_API_USER` / `CORREIOS_API_TOKEN` (código de acesso, não JWT)

## Stack
- Node.js + Playwright (Portal) + `postgres` + fetch (CWS status sync)
- Neon Postgres do NSControle (migrations em `scripts/migrations/`)
- Segredos só via env / Actions secrets; plano: [plano-rpa-correios.md](./plano-rpa-correios.md)
