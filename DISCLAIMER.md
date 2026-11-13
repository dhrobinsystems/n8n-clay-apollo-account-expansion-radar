# ⚠️ Disclaimer & Liability Limitation

Use at your own risk. The code, workflows, and scripts provided in this repository (`n8n-clay-apollo-account-expansion-radar`) are for educational and architectural demonstration purposes.

- **No Liability:** The author and dhRobin Systems assume no responsibility or liability for any direct, indirect, incidental, or consequential damages resulting from the use, misuse, or deployment of these scripts.
- **No Warranty:** All software, n8n JSON blueprints, and JavaScript modules are provided "AS IS" without warranty of any kind, express or implied, including but not limited to merchantability, fitness for a particular purpose, or non-infringement.
- **Production Testing Required:** Always test thoroughly in an isolated staging environment (for example a HubSpot developer test account or sandbox) with `SANDBOX_MODE=true` enabled before connecting live HubSpot, Apollo or Clay credentials.
- **Third-Party APIs & Compliance:** Users are solely responsible for complying with the terms of service, rate limits, credit usage, data privacy regulations (GDPR/CCPA), anti-spam laws (e.g. CAN-SPAM, CASL, PECR), and security policies of HubSpot, Apollo, Clay, Slack and any connected services, including honouring every unsubscribe request and reviewing every automated task, custom-object record, property change and sequence enrollment.

## Operational risks

- **Data writes:** in live mode the workflow creates custom-object records and tasks and updates company properties in HubSpot. Misconfiguration (wrong object type, association type, lifecycle stage or thresholds) can create incorrect or excessive records. Keep backups and test in a sandbox portal first.
- **Credits and costs:** Apollo enrichment and Clay enrichment consume paid credits. Run caps (`MAX_ACCOUNTS_PER_RUN`) and re-check cadence (`RECHECK_DAYS`) limit, but do not eliminate, spend.
- **Signal accuracy:** third-party firmographic, funding, technology and job-posting data can be incomplete, outdated or wrong. Signals and scores are heuristics for human review, not facts about any company.
- **Outreach:** the radar does not send email. If you connect the `expansion_radar_play` property to a HubSpot sequence or workflow, you are responsible for consent, lawful basis, opt-out handling and the content of every message sent.
- **Personal data:** enrichment data and job postings can contain personal data. Process it only with a lawful basis, minimise what you store, and honour data-subject requests in every system it reaches (HubSpot, Clay, Slack, n8n execution logs).

## Liability limitation

> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE. THE USER ASSUMES FULL RESPONSIBILITY FOR CRM DATA INTEGRITY, BACKUPS, API RATE LIMITS AND CREDIT USAGE, OUTREACH COMPLIANCE, AND COMPLIANCE WITH THIRD-PARTY TERMS OF SERVICE WHEN EXECUTING AUTOMATED WORKFLOWS IN PRODUCTION ENVIRONMENTS.

## License

Released under the MIT License. Copyright (c) 2026 DH Robin (dhRobin Systems). See [LICENSE](LICENSE).
