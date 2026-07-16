# CC-Viewer

🌐 **Websted og funktionsrundvisning: [weiesky.github.io/cc-viewer](https://weiesky.github.io/cc-viewer/)** — tilgængelig på 18 sprog.


Et Vibe Coding-værktøjssæt destilleret fra egen udviklingserfaring og bygget på Claude Code:

1. Hæv evneloftet: Kør /ultraPlan og /ultraReview lokalt, så din projektkode aldrig er fuldt eksponeret for Claudes cloud;
2. Multi-platform-understøttelse: Muliggør mobil programmering (i det lokale netværk); webversionen tilpasser sig forskellige scenarier, kan let indlejres i browserudvidelser og operativsystemets opdelte skærm, og leverer en native installer;
3. Fuldstændig logning: Tilbyder omfattende opfangelse og analyse af Claude Code-payloads — ideelt til logning, fejlfinding, læring, inspiration og reverse-engineering;
4. Læring og erfaringsudveksling: En lang række studiematerialer og udviklingserfaringer er samlet (se „?"-symbolerne overalt i systemet);
5. Native oplevelse bevaret: Udvider kun Claude Codes evner uden væsentlige ændringer i kernen — den native oplevelse bevares;
6. Tredjepartsmodeller understøttet: Kompatibel med deepseek-v4-\*, GLM 5.1, Kimi K2.6, med indbygget cc-switch-evne til hot-switching mellem tredjepartsværktøjer når som helst;

<img width="860" alt="cc-viewer — deploy once, share with every device" src="https://raw.githubusercontent.com/weiesky/cc-viewer/main/docs/cc-viewer-share.svg" />

[English](../README.md) | [简体中文](./README.zh.md) | [繁體中文](./README.zh-TW.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md) | [Deutsch](./README.de.md) | [Español](./README.es.md) | [Français](./README.fr.md) | [Italiano](./README.it.md) | Dansk | [Polski](./README.pl.md) | [Русский](./README.ru.md) | [العربية](./README.ar.md) | [Norsk](./README.no.md) | [Português (Brasil)](./README.pt-BR.md) | [ไทย](./README.th.md) | [Türkçe](./README.tr.md) | [Українська](./README.uk.md)

## Brug

### Forudsætninger

* Sørg for at have Node.js 20.0.0+ installeret; [Download og installation](https://nodejs.org)
* Sørg for at have Claude Code installeret; [Installationsvejledning](https://github.com/anthropics/claude-code)

### Installer ccv

#### Installation via npm

```bash
npm install -g cc-viewer --registry=https://registry.npmjs.org
```

#### Installation via Homebrew (anbefales til macOS / Linux)

```bash
brew tap weiesky/cc-viewer
brew install cc-viewer
brew upgrade cc-viewer   # brug denne til opgradering — brug IKKE npm install -g til ccv installeret via brew
```

### Sådan starter du

ccv er en direkte erstatning for claude — alle argumenter videregives til claude, samtidig med at Web Viewer startes.

```bash
ccv                    # == claude (interaktiv tilstand)
```

Den kommando forfatteren bruger mest er:

```
ccv -c --d             # == claude --continue --dangerously-skip-permissions
                       # ccv videregiver alle Claude Codes opstartsparametre — du kan kombinere dem som du vil
```

Efter at programmeringstilstanden er startet, åbnes en webside automatisk.

cc-viewer findes også som native desktop-app: [Downloadside](https://github.com/weiesky/cc-viewer/releases)

### Opgradering til 1.7.0 (logformat v2)

Fra 1.7.0 gemmes logs i et format med én mappe pr. session (wire-format v2) i stedet for enkelte `.jsonl`-filer — cirka 90 % mindre diskplads. Eksisterende v1-`.jsonl`-filer bliver aldrig ændret eller slettet; logdialogen viser som standard v2-sessioner, og en lille post “Vis ældre (v1) logs” (vises, så længe der findes gamle filer) åbner en v1-visning, hvor de kan ses, migreres eller slettes. Ved opstart tilbyder cc-viewer migrering med ét klik, når der findes ældre logs (stærkt anbefalet, når du fortsætter en gammel samtale med `claude -c`, hvis første halvdel ligger i de gamle filer). Du kan også migrere fra terminalen:

```bash
ccv convert <project>   # migrér ét projekt
ccv convert --all       # migrér alle projekter
ccv verify <v1-file>    # kontrollér en v1-fil mod dens konverterede sessioner
```

Hvis en session ikke består golden-verifikationen, holdes den tilbage i `sessions-quarantine/` til inspektion i stedet for at få hele migreringen til at mislykkes – de øvrige sessioner migreres stadig.

### Logger-tilstand

Hvis du stadig foretrækker det native claude-værktøj eller VS Code-udvidelsen, skal du bruge denne tilstand.

I denne tilstand starter `claude`

automatisk en logningsproces, der registrerer anmodningslogs til mapper pr. session under \~/.claude/cc-viewer/*yourproject*/sessions/ (wire-format v2)

Start logger-tilstand:

```bash
ccv -logger
```

Når konsollen ikke kan udskrive den specifikke port, er den første standardport 127.0.0.1:7008. Ved flere samtidige instanser bruges fortløbende porte som 7009, 7010.

Afinstaller logger-tilstand:

```bash
ccv --uninstall
```

### Fejlfinding (Troubleshooting)

Hvis du støder på opstartsproblemer, er her den ultimative fejlfindingstilgang:
Trin 1: Åbn Claude Code i en hvilken som helst mappe;
Trin 2: Giv Claude Code følgende instruks:

```
Jeg har installeret npm-pakken cc-viewer, men efter at have kørt ccv virker det stadig ikke korrekt. Tjek cli.js og findcc.js i cc-viewer og tilpas dem til den lokale Claude Code-udrulning baseret på det specifikke miljø. Hold ændringerne så begrænsede som muligt til findcc.js.
```

At lade Claude Code selv diagnosticere problemet er mere effektivt end at spørge nogen eller læse dokumentation!

Når instruktionen ovenfor er fuldført, opdateres findcc.js. Hvis dit projekt ofte kræver lokal udrulning eller forket kode ofte skal løse installationsproblemer, så behold blot denne fil. Næste gang kan du bare kopiere den. I øjeblikket bliver mange projekter og virksomheder, der bruger Claude Code, ikke udrullet på Mac, men i serverhostede miljøer, så forfatteren har separeret findcc.js for at gøre det lettere at følge cc-viewers kildekodeopdateringer fremover.

Bemærk: Denne applikation er i konflikt med claude-code-switch og claude-code-router, da der er et proxy-konkurrenceproblem, så sørg for at deaktivere claude-code-switch og claude-code-router, når du bruger cc-viewer — inden i cc-viewer leveres en proxy-hot-update-funktion som tilsvarende erstatning.

### Andre hjælpekommandoer

Se:

```bash
ccv -h
```

### Silent-tilstand (Silent Mode)

Som standard kører `ccv` i silent-tilstand, når den indpakker `claude`, hvilket holder dit terminaloutput rent og i overensstemmelse med den native oplevelse. Alle logs opsamles i baggrunden og kan vises på `http://localhost:7008`.

Efter konfiguration bruger du `claude`-kommandoen som normalt. Besøg `http://localhost:7008` for at få adgang til overvågningsgrænsefladen.

## Funktioner

### Programmeringstilstand

Efter start med ccv kan du se:

<img height="765" width="1500" alt="image" src="https://github.com/user-attachments/assets/ab353a2b-f101-409d-a28c-6a4e41571ea2" />

Du kan se code diffs direkte efter redigering:

<img height="728" width="1500" alt="image" src="https://github.com/user-attachments/assets/2a4acdaa-fc5f-4dc0-9e5f-f3273f0849b2" />

Selvom du manuelt kan åbne filer og kode, anbefales manuel programmering ikke — det er gammeldags kodning!

### Mobil programmering

Du kan endda scanne en QR-kode for at programmere fra din mobile enhed:

<img height="1460" width="3018" alt="image" src="https://github.com/user-attachments/assets/8debf48e-daec-420c-b37a-609f8b81cd20" />

<img height="790" width="1700" alt="image" src="https://github.com/user-attachments/assets/da3e519f-ff66-4cd2-81d1-f4e131215f6c" />

Opfyld din forestilling om mobil programmering. Der er også en plugin-mekanisme — hvis du har brug for tilpasninger til dine programmeringsvaner, kan du holde dig opdateret om kommende plugin-hook-opdateringer.

### Modelspecifikke systemprompter

Modalen **Rediger systemprompt** (hamburgermenu → Rediger systemprompt) er opdelt i faner:

* Fanen **Standard** bevarer den klassiske adfærd: den skriver `CC_SYSTEM.md` (overskriv) eller `CC_APPEND_SYSTEM.md` (tilføj) i det aktuelle arbejdsområde, injiceret som `--system-prompt-file` / `--append-system-prompt-file` ved næste ccv-start.
* **Modelfaner**: klik på **+ Tilføj model**, indtast et navn som `opus` eller `Gemini3`, og vælg et omfang — **Global** (`~/.claude/cc-viewer/system_prompt/`, gælder for alle arbejdsområder) eller **Arbejdsområde** (`<project>/system_prompt/`). Hver fane har sin egen Tilføj/Overskriv-kontakt og Markdown-forhåndsvisning.
* Posterne gemmes som filer med store bogstaver: `OPUS_SYSTEM.md` (overskriv) eller `OPUS_APPEND_SYSTEM.md` (tilføj). Matchningen er fuzzy — en delstreng, uden forskel på store og små bogstaver, af det model-ID der udledes af den AKTIVE konfiguration (den aktive tredjeparts proxy-profils modeltilknytning > miljøvariablerne `ANTHROPIC_MODEL`/`CLAUDE_MODEL` ved start > `model` i `settings.json`; uden konfigurationssignal injiceres ingen post), så `opus` matcher `claude-opus-4-8[1m]` uanset version. Et match i arbejdsområdet slår et globalt; inden for et omfang vinder det længste navn; en matchet post erstatter fuldstændigt Standard-filerne for den pågældende start. Kendte begrænsninger: skift af proxy-profil midt i en session matches først igen efter genstart af claude-sessionen; et `--model`-flag sendt via ekstra argumenter tages ikke i betragtning.
* Gemmes en fane tom, slettes posten. Modelskift foretaget midt i en session træder i kraft ved næste genstart. Sæt `CCV_DISABLE_AUTO_SYSTEM_PROMPT=1` for at deaktivere al automatisk injektion. Du kan committe `<project>/system_prompt/` for at dele prompter med dit team, eller tilføje den til `.gitignore` for at holde dem private.

### Logger-tilstand (Se komplette Claude Code-sessioner)

<img width="860" alt="cc-viewer — wire-level capture and packet decomposition" src="https://raw.githubusercontent.com/weiesky/cc-viewer/main/docs/cc-viewer-proxy.svg" />

* Opfanger alle API-anmodninger fra Claude Code i realtid og sikrer rå tekst — ikke redigerede logs (dette er vigtigt!!!)
* Identificerer og mærker automatisk Main Agent- og Sub Agent-anmodninger (undertyper: Plan, Search, Bash)
* MainAgent-anmodninger understøtter Body Diff JSON og viser sammenklappede forskelle fra den foregående MainAgent-anmodning (kun ændrede/nye felter)
* Hver anmodning viser inline Token-forbrugsstatistik (input/output-Tokens, cache-oprettelse/-læsning, hitrate)
* Kompatibel med Claude Code Router (CCR) og andre proxy-scenarier — falder tilbage til mønstermatchning af API-stier

<a href="https://www.star-history.com/?repos=weiesky%2Fcc-viewer&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=weiesky/cc-viewer&type=date&theme=dark&legend=top-left" />

    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=weiesky/cc-viewer&type=date&legend=top-left" />

    ![Star History Chart](https://api.star-history.com/chart?repos=weiesky/cc-viewer&type=date&legend=top-left)
  </picture>
</a>

## Licens

MIT
