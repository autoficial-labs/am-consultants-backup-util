//! Reads business data from Tally through its built-in XML server (TallyPrime and Tally.ERP 9,
//! "Client/Server configuration": acts as Server or Both, port 9000 by default).
//!
//! Tally's data files use a private format, so AM Backup never reads them directly. Instead,
//! when a company's files are backed up, it asks the running Tally for the company's ledgers
//! (with balances) and vouchers and saves that as a snapshot next to the backup. Snapshots
//! let people browse backed-up data and compare moments in Tally terms (vouchers and balances).

use anyhow::{anyhow, bail, Context, Result};
use flate2::{write::GzEncoder, Compression};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::Path;
use std::time::Duration;

use crate::api::Api;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TallyCompany {
    pub name: String,
    /// Tally company number; also the name of its data folder (for example 10000).
    pub number: Option<String>,
    pub guid: Option<String>,
    /// Start of the financial year (YYYY-MM-DD).
    pub starting_from: Option<String>,
    pub books_from: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Ledger {
    pub name: String,
    pub group: String,
    /// Tally convention: debit balances are negative, credit balances positive.
    pub opening: f64,
    pub closing: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Voucher {
    pub guid: String,
    pub master_id: i64,
    pub alter_id: i64,
    pub date: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub number: String,
    pub party: String,
    pub amount: f64,
    pub narration: String,
    pub cancelled: bool,
    pub optional: bool,
}

/// What is saved for one company. Contains no capture time, so an unchanged company gives
/// identical data (stored once).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub version: u32,
    pub company: TallyCompany,
    pub period: Period,
    pub ledgers: Vec<Ledger>,
    pub vouchers: Vec<Voucher>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Period {
    pub from: String,
    pub to: String,
}

// ---- small parsers --------------------------------------------------------------------

/// Tally amounts: "-1180.00", " 1,180.00", "1180.00 Dr", "₹ 1,180.00 Cr". Debit is negative.
pub fn parse_amount(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    let lower = t.to_ascii_lowercase();
    let mut n: String = t.chars().filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-').collect();
    // Some formats repeat the amount after an "=" or "@" (rates); keep the first number.
    if let Some(idx) = n[1.min(n.len())..].find('-') {
        n.truncate(idx + 1);
    }
    let v: f64 = n.parse().unwrap_or(0.0);
    if lower.ends_with("dr") {
        -v.abs()
    } else if lower.ends_with("cr") {
        v.abs()
    } else {
        v
    }
}

const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/// Tally dates: "20251104" or "4-Nov-2025" / "4-Nov-25" -> "2025-11-04".
pub fn parse_date(s: &str) -> Option<String> {
    let t = s.trim();
    if t.len() == 8 && t.bytes().all(|b| b.is_ascii_digit()) {
        return Some(format!("{}-{}-{}", &t[0..4], &t[4..6], &t[6..8]));
    }
    let parts: Vec<&str> = t.split(['-', ' ', '/']).filter(|p| !p.is_empty()).collect();
    if parts.len() == 3 {
        let day: u32 = parts[0].parse().ok()?;
        let month = MONTHS.iter().position(|m| parts[1].to_ascii_lowercase().starts_with(m))? as u32 + 1;
        let mut year: i32 = parts[2].parse().ok()?;
        if year < 100 {
            year += 2000;
        }
        return Some(format!("{year:04}-{month:02}-{day:02}"));
    }
    None
}

fn yes(s: &str) -> bool {
    s.trim().eq_ignore_ascii_case("yes")
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

/// Tally output can be UTF-16 (with a byte-order mark) and can contain character references
/// that XML 1.0 forbids (for example &#4;). Both are cleaned up before parsing.
pub fn decode_response(bytes: &[u8]) -> String {
    let text = if bytes.starts_with(&[0xFF, 0xFE]) {
        let units: Vec<u16> = bytes[2..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&units)
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        let units: Vec<u16> = bytes[2..].chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&units)
    } else {
        let b = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
        String::from_utf8_lossy(b).into_owned()
    };
    sanitize_xml(&text)
}

fn sanitize_xml(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find("&#") {
        out.push_str(&rest[..i]);
        let after = &rest[i + 2..];
        if let Some(end) = after.find(';') {
            let body = &after[..end];
            let code = if let Some(hex) = body.strip_prefix('x').or_else(|| body.strip_prefix('X')) {
                u32::from_str_radix(hex, 16).ok()
            } else {
                body.parse::<u32>().ok()
            };
            match code {
                Some(c) if c < 32 && c != 9 && c != 10 && c != 13 => {}
                _ => {
                    out.push_str("&#");
                    out.push_str(body);
                    out.push(';');
                }
            }
            rest = &after[end + 1..];
        } else {
            out.push_str("&#");
            rest = after;
        }
    }
    out.push_str(rest);
    // Raw control characters are just as invalid.
    out.retain(|c| !(c < ' ' && c != '\t' && c != '\n' && c != '\r'));
    out
}

/// Text of a child element, or of the attribute with that name.
fn field(node: roxmltree::Node, name: &str) -> String {
    node.children()
        .find(|c| c.is_element() && c.tag_name().name().eq_ignore_ascii_case(name))
        .map(|c| c.descendants().filter(|d| d.is_text()).map(|d| d.text().unwrap_or("")).collect::<String>())
        .or_else(|| node.attributes().find(|a| a.name().eq_ignore_ascii_case(name)).map(|a| a.value().to_string()))
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

fn opt(s: String) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn check_errors(doc: &roxmltree::Document) -> Result<()> {
    if let Some(e) = doc.descendants().find(|n| n.is_element() && n.tag_name().name().eq_ignore_ascii_case("LINEERROR")) {
        bail!("Tally answered with an error: {}", e.text().unwrap_or("unknown").trim());
    }
    Ok(())
}

pub fn parse_companies(xml: &str) -> Result<Vec<TallyCompany>> {
    let doc = roxmltree::Document::parse(xml).context("Tally's answer is not readable XML")?;
    check_errors(&doc)?;
    let mut out = Vec::new();
    for n in doc.descendants().filter(|n| n.is_element() && n.tag_name().name().eq_ignore_ascii_case("COMPANY")) {
        let name = field(n, "NAME");
        if name.is_empty() {
            continue;
        }
        out.push(TallyCompany {
            name,
            number: opt(field(n, "COMPANYNUMBER")),
            guid: opt(field(n, "GUID")),
            starting_from: parse_date(&field(n, "STARTINGFROM")),
            books_from: parse_date(&field(n, "BOOKSFROM")),
        });
    }
    out.dedup_by(|a, b| a.name == b.name);
    Ok(out)
}

pub fn parse_ledgers(xml: &str) -> Result<Vec<Ledger>> {
    let doc = roxmltree::Document::parse(xml).context("Tally's answer is not readable XML")?;
    check_errors(&doc)?;
    let mut out: Vec<Ledger> = doc
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name().eq_ignore_ascii_case("LEDGER"))
        .filter_map(|n| {
            let name = field(n, "NAME");
            (!name.is_empty()).then(|| Ledger {
                name,
                group: field(n, "PARENT"),
                opening: parse_amount(&field(n, "OPENINGBALANCE")),
                closing: parse_amount(&field(n, "CLOSINGBALANCE")),
            })
        })
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

pub fn parse_vouchers(xml: &str, from: &str, to: &str) -> Result<Vec<Voucher>> {
    let doc = roxmltree::Document::parse(xml).context("Tally's answer is not readable XML")?;
    check_errors(&doc)?;
    let mut out: Vec<Voucher> = doc
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name().eq_ignore_ascii_case("VOUCHER"))
        .filter_map(|n| {
            let date = parse_date(&field(n, "DATE"))?;
            if date.as_str() < from || date.as_str() > to {
                return None;
            }
            let master_id: i64 = field(n, "MASTERID").parse().unwrap_or(0);
            let guid = opt(field(n, "GUID")).unwrap_or_else(|| format!("masterid:{master_id}"));
            let mut narration = field(n, "NARRATION");
            if narration.chars().count() > 160 {
                narration = narration.chars().take(157).collect::<String>() + "…";
            }
            Some(Voucher {
                guid,
                master_id,
                alter_id: field(n, "ALTERID").parse().unwrap_or(0),
                date,
                kind: opt(field(n, "VOUCHERTYPENAME")).unwrap_or_else(|| n.attribute("VCHTYPE").unwrap_or("").to_string()),
                number: field(n, "VOUCHERNUMBER"),
                party: field(n, "PARTYLEDGERNAME"),
                amount: parse_amount(&field(n, "AMOUNT")),
                narration,
                cancelled: yes(&field(n, "ISCANCELLED")),
                optional: yes(&field(n, "ISOPTIONAL")),
            })
        })
        .collect();
    out.sort_by(|a, b| (a.date.as_str(), a.master_id).cmp(&(b.date.as_str(), b.master_id)));
    Ok(out)
}

// ---- client ---------------------------------------------------------------------------

pub struct TallyClient {
    client: Client,
    url: String,
    pub port: u16,
}

fn collection_request(id: &str, kind: &str, fetch: &str, company: Option<&str>, period: Option<(&str, &str)>) -> String {
    let mut vars = String::from("<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>");
    if let Some(c) = company {
        vars.push_str(&format!("<SVCURRENTCOMPANY>{}</SVCURRENTCOMPANY>", xml_escape(c)));
    }
    if let Some((from, to)) = period {
        let f = from.replace('-', "");
        let t = to.replace('-', "");
        vars.push_str(&format!("<SVFROMDATE TYPE=\"Date\">{f}</SVFROMDATE><SVTODATE TYPE=\"Date\">{t}</SVTODATE>"));
    }
    format!(
        "<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>{id}</ID></HEADER>\
<BODY><DESC><STATICVARIABLES>{vars}</STATICVARIABLES><TDL><TDLMESSAGE>\
<COLLECTION NAME=\"{id}\" ISMODIFY=\"No\"><TYPE>{kind}</TYPE><FETCH>{fetch}</FETCH></COLLECTION>\
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>"
    )
}

impl TallyClient {
    pub fn new(port: u16) -> Self {
        Self::with_url(&format!("http://127.0.0.1:{port}"), port)
    }

    pub fn with_url(url: &str, port: u16) -> Self {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(180))
            .no_proxy()
            .build()
            .expect("HTTP client");
        Self { client, url: url.trim_end_matches('/').to_string(), port }
    }

    async fn post(&self, body: String) -> Result<String> {
        let res = self
            .client
            .post(&self.url)
            .header("content-type", "text/xml; charset=utf-8")
            .body(body)
            .send()
            .await
            .map_err(|e| {
                if e.is_connect() || e.is_timeout() {
                    anyhow!("Tally is not answering on port {}. Open Tally and turn on its XML server (Client/Server configuration).", self.port)
                } else {
                    anyhow!("Could not talk to Tally: {e}")
                }
            })?;
        if !res.status().is_success() {
            bail!("Tally answered {}", res.status());
        }
        Ok(decode_response(&res.bytes().await?))
    }

    /// Companies currently open in Tally.
    pub async fn companies(&self) -> Result<Vec<TallyCompany>> {
        let full = self.post(collection_request("AMBCompanies", "Company", "Name, CompanyNumber, GUID, StartingFrom, BooksFrom", None, None)).await?;
        match parse_companies(&full) {
            Ok(c) => Ok(c),
            // Older releases may not know every field; the name alone is enough.
            Err(_) => parse_companies(&self.post(collection_request("AMBCompanies", "Company", "Name", None, None)).await?),
        }
    }

    pub async fn ledgers(&self, company: &str, from: &str, to: &str) -> Result<Vec<Ledger>> {
        let xml = self
            .post(collection_request("AMBLedgers", "Ledger", "Name, Parent, OpeningBalance, ClosingBalance", Some(company), Some((from, to))))
            .await?;
        parse_ledgers(&xml)
    }

    pub async fn vouchers(&self, company: &str, from: &str, to: &str) -> Result<Vec<Voucher>> {
        let xml = self
            .post(collection_request(
                "AMBVouchers",
                "Voucher",
                "Date, VoucherTypeName, VoucherNumber, PartyLedgerName, Amount, Narration, GUID, MasterID, AlterID, IsCancelled, IsOptional",
                Some(company),
                Some((from, to)),
            ))
            .await?;
        parse_vouchers(&xml, from, to)
    }

    /// Ledgers and vouchers of the last 13 months (the current year plus late entries to the last one).
    pub async fn snapshot(&self, company: &TallyCompany, today: chrono::NaiveDate) -> Result<Snapshot> {
        use chrono::Datelike;
        let start = today.with_day(1).unwrap_or(today) - chrono::Months::new(13);
        let from = start.format("%Y-%m-%d").to_string();
        let to = today.format("%Y-%m-%d").to_string();
        let ledgers = self.ledgers(&company.name, &from, &to).await?;
        let vouchers = self.vouchers(&company.name, &from, &to).await?;
        Ok(Snapshot { version: 1, company: company.clone(), period: Period { from, to }, ledgers, vouchers })
    }
}

// ---- saving ---------------------------------------------------------------------------

/// The backed-up folder of a company: the folder named after its company number.
pub fn company_folder(root: &Path, company: &TallyCompany) -> Option<String> {
    let number = company.number.as_deref()?;
    let walker = walkdir::WalkDir::new(root).min_depth(1).max_depth(4).into_iter().filter_entry(|e| e.file_type().is_dir());
    for e in walker.flatten() {
        if e.file_name().to_string_lossy().eq_ignore_ascii_case(number) {
            let rel = e.path().strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/");
            return Some(rel);
        }
    }
    None
}

pub fn company_key(company: &TallyCompany) -> String {
    company.number.clone().unwrap_or_else(|| company.name.clone())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSnapshot {
    pub company_key: String,
    pub company_name: String,
    pub folder: Option<String>,
    pub hash: String,
    pub ledgers: usize,
    pub vouchers: usize,
    /// false when the data was the same as the last snapshot, so nothing new was recorded.
    pub recorded: bool,
}

/// Uploads a snapshot (gzip JSON, stored once per content) and records it for the company.
pub async fn save(api: &Api, snap: &Snapshot, folder: Option<String>, captured_at: i64, last_hash: Option<&str>) -> Result<SavedSnapshot> {
    let raw = serde_json::to_vec(snap)?;
    let hash = hex::encode(Sha256::digest(&raw));
    let key = company_key(&snap.company);
    let mut saved = SavedSnapshot {
        company_key: key.clone(),
        company_name: snap.company.name.clone(),
        folder: folder.clone(),
        hash: hash.clone(),
        ledgers: snap.ledgers.len(),
        vouchers: snap.vouchers.len(),
        recorded: false,
    };
    if last_hash == Some(hash.as_str()) {
        return Ok(saved);
    }
    let mut gz = GzEncoder::new(Vec::with_capacity(raw.len() / 6), Compression::new(7));
    gz.write_all(&raw)?;
    let packed = gz.finish()?;
    let _: Value = api.put_bytes(&format!("/api/tally/data/{hash}"), packed, &[("x-raw-size", raw.len().to_string())]).await?;
    let last_voucher = snap.vouchers.iter().map(|v| v.date.as_str()).max().map(str::to_string);
    let _: Value = api
        .post(
            "/api/tally/snapshots",
            &json!({
                "hash": hash,
                "companyKey": key,
                "companyName": snap.company.name,
                "folder": folder,
                "capturedAt": captured_at,
                "ledgers": snap.ledgers.len(),
                "vouchers": snap.vouchers.len(),
                "lastVoucher": last_voucher,
            }),
        )
        .await?;
    saved.recorded = true;
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amounts() {
        assert_eq!(parse_amount("-1180.00"), -1180.0);
        assert_eq!(parse_amount(" 1,180.50"), 1180.5);
        assert_eq!(parse_amount("1180.00 Dr"), -1180.0);
        assert_eq!(parse_amount("₹ 2,000.00 Cr"), 2000.0);
        assert_eq!(parse_amount(""), 0.0);
    }

    #[test]
    fn dates() {
        assert_eq!(parse_date("20251104").as_deref(), Some("2025-11-04"));
        assert_eq!(parse_date("4-Nov-2025").as_deref(), Some("2025-11-04"));
        assert_eq!(parse_date("1-Apr-25").as_deref(), Some("2025-04-01"));
        assert_eq!(parse_date("rubbish"), None);
    }

    #[test]
    fn decodes_utf16_and_bad_references() {
        let xml = "<ENVELOPE><COMPANY><NAME>A&#4;B &amp; Co</NAME></COMPANY></ENVELOPE>";
        let mut bytes = vec![0xFF, 0xFE];
        for u in xml.encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        let text = decode_response(&bytes);
        let c = parse_companies(&text).unwrap();
        assert_eq!(c[0].name, "AB & Co");
    }

    #[test]
    fn parses_collections() {
        let xml = r#"<ENVELOPE><BODY><DATA><COLLECTION>
          <LEDGER NAME="Cash"><PARENT TYPE="String">Cash-in-Hand</PARENT><OPENINGBALANCE TYPE="Amount">-1000.00</OPENINGBALANCE><CLOSINGBALANCE TYPE="Amount">-2500.00</CLOSINGBALANCE></LEDGER>
          <LEDGER NAME="Sales Accounts"><PARENT>Sales Accounts</PARENT><CLOSINGBALANCE>15000.00</CLOSINGBALANCE></LEDGER>
        </COLLECTION></DATA></BODY></ENVELOPE>"#;
        let l = parse_ledgers(xml).unwrap();
        assert_eq!(l.len(), 2);
        assert_eq!((l[0].name.as_str(), l[0].closing), ("Cash", -2500.0));
        let v = r#"<ENVELOPE><BODY><DATA><COLLECTION>
          <VOUCHER VCHTYPE="Sales"><DATE TYPE="Date">20251104</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>12</VOUCHERNUMBER>
            <PARTYLEDGERNAME>Mehta Stores</PARTYLEDGERNAME><AMOUNT>-1180.00</AMOUNT><GUID>abc-1</GUID><MASTERID> 41</MASTERID><ALTERID> 77</ALTERID></VOUCHER>
          <VOUCHER><DATE>20200101</DATE><GUID>old</GUID></VOUCHER>
        </COLLECTION></DATA></BODY></ENVELOPE>"#;
        let vs = parse_vouchers(v, "2025-01-01", "2025-12-31").unwrap();
        assert_eq!(vs.len(), 1, "out-of-range voucher dropped");
        assert_eq!((vs[0].master_id, vs[0].alter_id, vs[0].amount), (41, 77, -1180.0));
        let err = parse_ledgers("<ENVELOPE><BODY><DATA><LINEERROR>Could not find Company 'X'</LINEERROR></DATA></BODY></ENVELOPE>").unwrap_err();
        assert!(err.to_string().contains("Could not find"));
    }

    #[test]
    fn request_escapes_company_name() {
        let r = collection_request("X", "Ledger", "Name", Some("A & B <Traders>"), Some(("2025-04-01", "2026-03-31")));
        assert!(r.contains("<SVCURRENTCOMPANY>A &amp; B &lt;Traders&gt;</SVCURRENTCOMPANY>"));
        assert!(r.contains("<SVFROMDATE TYPE=\"Date\">20250401</SVFROMDATE>"));
    }
}
