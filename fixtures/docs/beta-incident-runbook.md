# Beta Labs Incident Runbook

## Severity levels

Sev-1 means customer-facing data loss or a full outage. Sev-2 is a major feature outage with a workaround. Sev-3 is a minor degradation. Only sev-1 pages the incident commander outside working hours.

## Declaring an incident

Open the incident channel and post the summary, the affected service and the time it started. The first responder becomes the incident lead until the incident commander takes over. Status updates are posted every 20 minutes during a sev-1 and every hour during a sev-2.

## Communication

Customers are notified through the status page within 30 minutes of a confirmed sev-1. Internal updates go to the incident channel only. Do not speculate about root cause in customer communications.

## Mitigation first

Prefer rollback over forward fixes during an incident. The rollback command is documented in the deploy guide and must be executed by two people. Freeze deployments until the incident lead lifts the freeze.

## After the incident

Hold a blameless review within five working days. The review produces a timeline, contributing factors and follow-up tasks with owners and due dates. Tasks are tracked in the engineering board and reviewed weekly until closed.
