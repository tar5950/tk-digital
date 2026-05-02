#!/usr/bin/env python3
"""
TK Digital — Générateur d'articles blog automatique.

Lance ce script Mon/Wed/Fri via GitHub Actions. Il :
1. Choisit un sujet pas encore publié dans article-briefs.json
2. Charge les verbatims des personas pour ancrer le ton
3. Demande à Gemini de rédiger l'article (avec garde-fous stricts)
4. Vérifie la qualité (pas de chiffres bidons, pas de promesses creuses)
5. Génère le HTML et update /blog/index.html

Variables d'environnement requises :
- GEMINI_API_KEY : clé API Google Gemini (stockée comme secret GitHub)
"""

import os
import json
import re
import sys
import datetime
from pathlib import Path
import urllib.request
import urllib.error

# ─────────────────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
BLOG = ROOT / "blog"
ARTICLES = BLOG / "articles"
BRIEFS_FILE = SCRIPTS / "article-briefs.json"
PERSONAS_FILE = SCRIPTS / "personas-data.json"
INDEX_BLOG = BLOG / "index.html"

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = "gemini-2.5-flash"  # tier gratuit, qualité largement suffisante
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"

# Mots interdits qui indiquent du contenu IA bullshit
BANNED_PHRASES = [
    "révolutionn",  # "révolutionner", "révolutionnaire"
    "incroyable",
    "le meilleur du marché",
    "leader incontesté",
    "ROI optimisé",
    "synergie",
    "100% garanti",
    "premier sur Google en 7 jours",
    "doubler votre CA",
    "tripler vos clients",
    "transformation digitale réussie",
    "à l'ère du numérique",
    "dans un monde en constante évolution",
]


# ─────────────────────────────────────────────────────────
# UTILS
# ─────────────────────────────────────────────────────────
def log(msg):
    print(f"[blog-gen {datetime.datetime.now().isoformat(timespec='seconds')}] {msg}")


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def already_published_slugs():
    """Liste des slugs déjà présents dans /blog/articles/."""
    if not ARTICLES.exists():
        return set()
    slugs = set()
    for f in ARTICLES.glob("*.html"):
        # filename = 2026-05-04-uber-eats-cout-reel.html → on capture le slug
        m = re.match(r"\d{4}-\d{2}-\d{2}-(.+)\.html$", f.name)
        if m:
            slugs.add(m.group(1))
    return slugs


def pick_topic(briefs, published_slugs):
    """Choisit le prochain sujet pas encore publié, en alternant les catégories."""
    # On veut un mix équilibré : tente d'alterner les catégories
    # On compte les articles publiés par catégorie pour rééquilibrer
    counts = {"restos": 0, "barbiers": 0, "seo_local": 0}
    for f in ARTICLES.glob("*.html"):
        # Lire la catégorie depuis le data-attribute (qu'on injectera)
        try:
            html = f.read_text(encoding="utf-8")
            for cat in counts:
                if f'data-category="{cat}"' in html:
                    counts[cat] += 1
                    break
        except Exception:
            pass

    # Trier les catégories par count croissant (la moins servie passe en premier)
    sorted_cats = sorted(counts.keys(), key=lambda c: counts[c])

    for cat in sorted_cats:
        for topic in briefs["topics"]:
            if topic["category"] == cat and topic["slug"] not in published_slugs:
                return topic

    # Fallback : n'importe quel sujet pas publié
    for topic in briefs["topics"]:
        if topic["slug"] not in published_slugs:
            return topic

    return None  # tout est publié


def build_prompt(topic, personas):
    """Construit le prompt Gemini avec garde-fous stricts."""
    # Sélectionne les verbatims pertinents selon la catégorie
    if topic["category"] == "restos":
        relevant_verbatims = personas["restos"]["verbatims_directs"]
        relevant_pains = personas["restos"]["pain_points"]
        geo = personas["restos"]["geo"]
    elif topic["category"] == "barbiers":
        relevant_verbatims = [v["quote"] for v in personas["barbiers"]["verbatims_directs_sources"]]
        relevant_pains = personas["barbiers"]["pain_points"]
        geo = personas["barbiers"]["geo"]
    else:  # seo_local
        relevant_verbatims = personas["restos"]["verbatims_directs"][:3] + [
            v["quote"] for v in personas["barbiers"]["verbatims_directs_sources"][:3]
        ]
        relevant_pains = personas["restos"]["pain_points"][:4] + personas["barbiers"]["pain_points"][:4]
        geo = personas["restos"]["geo"]

    rules = personas["regles_redaction"]
    tarik = personas["tarik_authority"]

    prompt = f"""Tu es Tarik, fondateur de TK Digital. Tu rédiges UN article de blog pour ton site.

# CONTEXTE
{tarik['histoire']}

# SUJET DE L'ARTICLE
- Titre proposé : "{topic['title']}"
- Catégorie : {topic['category']}
- Mot-clé principal : "{topic['keyword_principal']}"
- Mots-clés secondaires : {', '.join(topic['keyword_secondaires'])}
- Intent de recherche : {topic['intent']}
- Angle éditorial : {topic['angle']}
- CTA final : invite le lecteur à visiter "{topic['cta_landing']}"

# TON & VOIX
- Ton : {rules['ton']}
- Tutoiement obligatoire ("tu", "ta", "ton")
- Pas de jargon. Si tu utilises un mot technique, explique-le simplement.

# DOULEURS À ANCRER (ne pas les inventer, les RECONNAÎTRE)
{chr(10).join(f'- {p}' for p in relevant_pains)}

# VERBATIMS AUTHENTIQUES (utilise au moins UN dans l'article, entre guillemets)
{chr(10).join(f'- "{v}"' for v in relevant_verbatims)}

# ZONE GÉOGRAPHIQUE
Articles ciblés : {', '.join(geo)}. Mentionne 1-2 villes du Nord de France si pertinent.

# RÈGLES STRICTES — INTERDIT :
{chr(10).join(f'- {r}' for r in rules['INTERDIT'])}

# RÈGLES STRICTES — OBLIGATOIRE :
{chr(10).join(f'- {r}' for r in rules['OBLIGATOIRE'])}

# STRUCTURE DE L'ARTICLE
1. **Titre H1** (le titre proposé, ou une variation plus accrocheuse)
2. **Intro** (3-4 phrases, hook + promesse de l'article)
3. **3-5 sections H2** avec sous-titres clairs
4. **Sous-sections H3** si pertinent
5. **FAQ courte** (3-5 questions) en fin d'article
6. **CTA final** : 1-2 phrases qui invitent à visiter "{topic['cta_landing']}" (sur le même site, lien relatif)

# FORMAT DE SORTIE — TRÈS IMPORTANT
Réponds UNIQUEMENT avec un objet JSON valide (pas de markdown, pas de ```json), avec ces clés :

{{
  "title": "Titre H1 final",
  "meta_description": "Méta description SEO (max 155 caractères)",
  "intro": "Paragraphe d'intro (3-4 phrases)",
  "sections": [
    {{ "h2": "Titre section 1", "content": "Contenu de la section en HTML simple (paragraphes <p>, listes <ul><li>, sous-titres <h3>)" }},
    {{ "h2": "Titre section 2", "content": "..." }},
    ...
  ],
  "faq": [
    {{ "q": "Question 1 ?", "a": "Réponse courte" }},
    ...
  ],
  "cta_text": "Texte du CTA final (1-2 phrases avec lien vers {topic['cta_landing']})",
  "reading_time_min": 4
}}

Longueur totale : 800-1200 mots. Pas plus, pas moins.
N'invente AUCUN chiffre. Si tu cites un chiffre, il doit venir des sources fournies (BreizhApp, Trustpilot, INSEE, etc.) ou être un calcul transparent du type "30% × 200 commandes × 18€ = 1 080€/mois".
"""
    return prompt


def call_gemini(prompt):
    """Appelle l'API Gemini et retourne le texte généré."""
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY missing")

    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.7,
            "topP": 0.9,
            "maxOutputTokens": 4096,
            "responseMimeType": "application/json",
        },
    }

    url = f"{GEMINI_URL}?key={GEMINI_API_KEY}"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Gemini API error {e.code}: {body}")

    candidates = data.get("candidates", [])
    if not candidates:
        raise RuntimeError(f"Gemini returned no candidates: {data}")

    parts = candidates[0].get("content", {}).get("parts", [])
    if not parts:
        raise RuntimeError(f"Gemini returned no content parts: {data}")

    return parts[0].get("text", "")


def validate_article(article):
    """Vérifie que l'article ne contient pas de bullshit interdit."""
    full_text = json.dumps(article, ensure_ascii=False).lower()
    for banned in BANNED_PHRASES:
        if banned.lower() in full_text:
            log(f"⚠️ Banned phrase detected: '{banned}'")
            return False, f"Contains banned phrase: {banned}"

    # Vérifie la longueur approximative (au moins 800 mots)
    body_text = article.get("intro", "") + " " + " ".join(s.get("content", "") for s in article.get("sections", []))
    word_count = len(re.findall(r"\w+", body_text))
    if word_count < 600:
        return False, f"Too short: {word_count} words (min 600)"
    if word_count > 1800:
        return False, f"Too long: {word_count} words (max 1800)"

    # Vérifie présence des champs obligatoires
    required = ["title", "meta_description", "intro", "sections", "faq", "cta_text"]
    for field in required:
        if field not in article or not article[field]:
            return False, f"Missing field: {field}"

    if len(article["meta_description"]) > 165:
        return False, f"Meta description too long: {len(article['meta_description'])} chars (max 165)"

    return True, "OK"


def find_related_articles(current_topic, all_articles, limit=3):
    """Trouve les articles existants les plus pertinents (même catégorie ou keywords proches)."""
    if not all_articles:
        return []

    scored = []
    current_keywords = set([current_topic["keyword_principal"].lower()] +
                           [k.lower() for k in current_topic["keyword_secondaires"]])

    for art in all_articles:
        score = 0
        # Bonus si même catégorie
        if art.get("category") == current_topic["category"]:
            score += 5
        # Bonus si keywords overlap dans le titre
        title_lower = art.get("title", "").lower()
        for kw in current_keywords:
            if kw in title_lower:
                score += 3
        # Bonus si excerpt mentionne keywords
        excerpt_lower = art.get("excerpt", "").lower()
        for kw in current_keywords:
            if kw in excerpt_lower:
                score += 1
        if score > 0:
            scored.append((score, art))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [a for _, a in scored[:limit]]


def render_article_html(article, topic, date_str, related_articles=None):
    """Génère le HTML complet de l'article."""
    related_articles = related_articles or []

    sections_html = ""
    for sec in article["sections"]:
        sections_html += f'\n      <h2>{sec["h2"]}</h2>\n      {sec["content"]}\n'

    faq_html = ""
    if article.get("faq"):
        faq_html = '\n      <h2>FAQ</h2>\n      <div class="faq-list">'
        for item in article["faq"]:
            faq_html += f'\n        <div class="faq-item"><h3>{item["q"]}</h3><p>{item["a"]}</p></div>'
        faq_html += "\n      </div>"

    canonical_url = f"https://tar5950.github.io/tk-digital/blog/articles/{date_str}-{topic['slug']}.html"

    # Internal linking : section "À lire aussi" en fin
    related_html = ""
    if related_articles:
        related_html = '\n  <section class="related">\n    <h2>À lire aussi</h2>\n    <div class="related-grid">'
        for art in related_articles:
            related_html += f"""
      <a href="{art['date']}-{art['slug']}.html" class="related-card">
        <div class="related-cat">{art['category'].replace('_', ' ').title()}</div>
        <div class="related-title">{art['title']}</div>
      </a>"""
        related_html += "\n    </div>\n  </section>"

    # Schema.org enrichi (Article + Author + Organization + BreadcrumbList)
    schema_article = {
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        "headline": article['title'],
        "description": article['meta_description'],
        "datePublished": date_str,
        "dateModified": date_str,
        "author": {
            "@type": "Person",
            "name": "Tarik",
            "url": "https://tar5950.github.io/tk-digital/blog/auteur/tarik.html",
            "jobTitle": "Fondateur de TK Digital"
        },
        "publisher": {
            "@type": "Organization",
            "name": "TK Digital",
            "url": "https://tar5950.github.io/tk-digital/",
            "logo": {
                "@type": "ImageObject",
                "url": "https://tar5950.github.io/tk-digital/favicon-192.png"
            }
        },
        "mainEntityOfPage": {"@type": "WebPage", "@id": canonical_url}
    }

    # Schema FAQPage si on a des FAQ
    schema_faq = ""
    if article.get("faq"):
        faq_data = {
            "@context": "https://schema.org",
            "@type": "FAQPage",
            "mainEntity": [
                {
                    "@type": "Question",
                    "name": item["q"],
                    "acceptedAnswer": {"@type": "Answer", "text": item["a"]}
                }
                for item in article["faq"]
            ]
        }
        schema_faq = f'\n<script type="application/ld+json">{json.dumps(faq_data, ensure_ascii=False)}</script>'

    schema_breadcrumb = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Accueil", "item": "https://tar5950.github.io/tk-digital/"},
            {"@type": "ListItem", "position": 2, "name": "Blog", "item": "https://tar5950.github.io/tk-digital/blog/"},
            {"@type": "ListItem", "position": 3, "name": article['title'], "item": canonical_url}
        ]
    }

    html = f"""<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{article['title']} | TK Digital</title>
<meta name="description" content="{article['meta_description']}">
<meta name="keywords" content="{topic['keyword_principal']}, {', '.join(topic['keyword_secondaires'])}">
<link rel="canonical" href="{canonical_url}">
<meta property="og:type" content="article">
<meta property="og:title" content="{article['title']}">
<meta property="og:description" content="{article['meta_description']}">
<meta property="og:url" content="{canonical_url}">
<script type="application/ld+json">{json.dumps(schema_article, ensure_ascii=False)}</script>
<script type="application/ld+json">{json.dumps(schema_breadcrumb, ensure_ascii=False)}</script>{schema_faq}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
:root{{--n:#050505;--n2:#0c0c0c;--n3:#141414;--n4:#1e1e1e;--n5:#2a2a2a;--a:#c8f135;--a2:#d4ff4a;--w:#f5f5f0;--w2:#e8e8e2;--mid:#888880;}}
*,*::before,*::after{{margin:0;padding:0;box-sizing:border-box;}}
html{{scroll-behavior:smooth;}}
body{{background:var(--n);color:var(--w);font-family:'DM Sans',sans-serif;line-height:1.7;}}
nav{{position:sticky;top:0;background:rgba(5,5,5,.96);backdrop-filter:blur(20px);border-bottom:1px solid rgba(200,241,53,.12);padding:14px 5%;display:flex;align-items:center;justify-content:space-between;z-index:100;}}
nav a.logo{{font-family:'Syne',sans-serif;font-size:18px;font-weight:800;color:var(--w);text-decoration:none;letter-spacing:.04em;}}
nav a.logo span{{color:var(--a);}}
nav .nav-back{{font-size:13px;color:var(--mid);text-decoration:none;transition:color .2s;}}
nav .nav-back:hover{{color:var(--a);}}
.crumb{{padding:24px 5%;font-size:12px;color:var(--mid);}}
.crumb a{{color:var(--mid);text-decoration:none;}}
.crumb a:hover{{color:var(--a);}}
article{{max-width:760px;margin:0 auto;padding:32px 5% 80px;}}
.art-meta{{display:flex;gap:14px;font-size:12px;color:var(--mid);margin-bottom:24px;flex-wrap:wrap;}}
.art-meta span{{display:inline-flex;align-items:center;gap:6px;}}
article h1{{font-family:'Syne',sans-serif;font-size:clamp(32px,5vw,48px);font-weight:800;line-height:1.15;color:var(--w);margin-bottom:24px;letter-spacing:-.02em;}}
article h2{{font-family:'Syne',sans-serif;font-size:clamp(22px,3vw,28px);font-weight:700;color:var(--w);margin:48px 0 18px;line-height:1.25;}}
article h3{{font-family:'Syne',sans-serif;font-size:18px;font-weight:700;color:var(--a);margin:28px 0 12px;}}
article p{{font-size:15px;color:var(--w2);margin-bottom:16px;}}
article ul,article ol{{margin:0 0 18px 22px;color:var(--w2);}}
article li{{font-size:15px;margin-bottom:8px;}}
article blockquote{{border-left:3px solid var(--a);background:rgba(200,241,53,.05);padding:16px 22px;margin:24px 0;font-style:italic;color:var(--w);border-radius:0 4px 4px 0;}}
article strong{{color:var(--w);font-weight:600;}}
article a{{color:var(--a);}}
.intro{{font-size:17px;color:var(--w);background:var(--n3);padding:22px;border-radius:6px;border-left:3px solid var(--a);}}
.faq-list{{display:flex;flex-direction:column;gap:14px;margin-top:20px;}}
.faq-item{{background:var(--n3);border:1px solid var(--n4);border-radius:6px;padding:18px 20px;}}
.faq-item h3{{font-size:15px;color:var(--w);margin:0 0 8px;}}
.faq-item p{{font-size:14px;margin:0;}}
.cta-final{{margin-top:48px;padding:32px;background:linear-gradient(135deg,rgba(200,241,53,.08),rgba(200,241,53,.02));border:1px solid rgba(200,241,53,.25);border-radius:10px;text-align:center;}}
.cta-final p{{color:var(--w);font-size:16px;margin-bottom:16px;}}
.cta-final a.btn-a{{display:inline-block;font-family:'Syne',sans-serif;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--n);background:var(--a);padding:14px 28px;text-decoration:none;border-radius:3px;}}
.cta-final a.btn-a:hover{{background:var(--a2);}}
.author-byline{{display:flex;align-items:center;gap:14px;background:var(--n3);border:1px solid var(--n4);border-radius:8px;padding:14px 18px;margin:24px 0 32px;}}
.author-byline-img{{width:42px;height:42px;border-radius:50%;background:var(--n4) center/cover;flex-shrink:0;border:2px solid var(--a);}}
.author-byline-txt{{font-size:13px;color:var(--mid);line-height:1.5;}}
.author-byline-txt a{{color:var(--w);font-weight:600;text-decoration:none;}}
.author-byline-txt a:hover{{color:var(--a);}}
.author-byline-txt span{{font-size:11px;color:var(--mid);display:block;margin-top:2px;}}
.related{{max-width:760px;margin:48px auto 0;padding:32px 5% 0;border-top:1px solid var(--n4);}}
.related h2{{font-family:'Syne',sans-serif;font-size:20px;color:var(--w);margin-bottom:18px;}}
.related-grid{{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;}}
.related-card{{background:var(--n3);border:1px solid var(--n4);border-radius:8px;padding:18px;text-decoration:none;color:inherit;transition:border-color .25s,transform .25s;}}
.related-card:hover{{border-color:rgba(200,241,53,.4);transform:translateY(-2px);}}
.related-cat{{font-family:'Syne',sans-serif;font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:var(--a);margin-bottom:8px;}}
.related-title{{font-family:'Syne',sans-serif;font-size:14px;font-weight:700;color:var(--w);line-height:1.35;}}
@media(max-width:768px){{.related-grid{{grid-template-columns:1fr;}}}}
footer{{background:var(--n2);border-top:1px solid var(--n4);padding:32px 5%;text-align:center;font-size:12px;color:var(--mid);}}
footer a{{color:var(--a);text-decoration:none;}}
</style>
</head>
<body data-category="{topic['category']}">

<nav>
  <a href="../../index.html" class="logo">TK <span>Digital</span></a>
  <a href="../index.html" class="nav-back">← Tous les articles</a>
</nav>

<div class="crumb">
  <a href="../../index.html">Accueil</a> · <a href="../index.html">Blog</a> · {topic['category'].replace('_', ' ').title()}
</div>

<article>
  <div class="art-meta">
    <span>📅 {date_str}</span>
    <span>⏱️ {article.get('reading_time_min', 4)} min de lecture</span>
    <span>📁 {topic['category'].replace('_', ' ').title()}</span>
  </div>

  <h1>{article['title']}</h1>

  <div class="author-byline">
    <div class="author-byline-img" style="background-image:url('../../images/hero-restaurateur.png');"></div>
    <div class="author-byline-txt">
      Écrit par <a href="../auteur/tarik.html">Tarik</a>, fondateur de TK Digital
      <span>7 ans dans la restauration halal du Nord avant de coder pour ses confrères commerçants. <a href="../auteur/tarik.html" style="color:var(--a);">En savoir plus →</a></span>
    </div>
  </div>

  <p class="intro">{article['intro']}</p>

  {sections_html}

  {faq_html}

  <div class="cta-final">
    <p>{article['cta_text']}</p>
    <a href="../../{topic['cta_landing']}" class="btn-a">Voir la solution →</a>
  </div>
</article>
{related_html}

<footer>
  © 2026 TK Digital · Tarik · Douai, Nord de France · <a href="../../index.html">Retour au site</a>
</footer>

</body>
</html>
"""
    return html


def update_blog_index(briefs, published_articles):
    """Régénère /blog/index.html avec la liste des articles publiés."""
    cards_html = ""
    for art in sorted(published_articles, key=lambda a: a["date"], reverse=True):
        cards_html += f"""
    <a href="articles/{art['date']}-{art['slug']}.html" class="post-card">
      <div class="post-cat">{art['category'].replace('_', ' ').title()}</div>
      <h2 class="post-title">{art['title']}</h2>
      <div class="post-meta">📅 {art['date']} · ⏱️ {art.get('reading_time', 4)} min</div>
      <p class="post-excerpt">{art['excerpt']}</p>
    </a>
"""

    html = f"""<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Blog TK Digital — Conseils SEO, Google et WhatsApp pour les commerces du Nord</title>
<meta name="description" content="Guides pratiques pour les restaurateurs et barbiers du Nord : Uber Eats, Planity, fiche Google, commande WhatsApp. Articles publiés Mon/Wed/Fri.">
<link rel="canonical" href="https://tar5950.github.io/tk-digital/blog/">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
:root{{--n:#050505;--n2:#0c0c0c;--n3:#141414;--n4:#1e1e1e;--n5:#2a2a2a;--a:#c8f135;--a2:#d4ff4a;--w:#f5f5f0;--w2:#e8e8e2;--mid:#888880;}}
*,*::before,*::after{{margin:0;padding:0;box-sizing:border-box;}}
html{{scroll-behavior:smooth;}}
body{{background:var(--n);color:var(--w);font-family:'DM Sans',sans-serif;line-height:1.6;}}
nav{{position:sticky;top:0;background:rgba(5,5,5,.96);backdrop-filter:blur(20px);border-bottom:1px solid rgba(200,241,53,.12);padding:14px 5%;display:flex;align-items:center;justify-content:space-between;z-index:100;}}
nav a.logo{{font-family:'Syne',sans-serif;font-size:18px;font-weight:800;color:var(--w);text-decoration:none;letter-spacing:.04em;}}
nav a.logo span{{color:var(--a);}}
nav .nav-back{{font-size:13px;color:var(--mid);text-decoration:none;transition:color .2s;}}
nav .nav-back:hover{{color:var(--a);}}
.hero{{padding:80px 5% 60px;text-align:center;border-bottom:1px solid var(--n4);}}
.eyebrow{{font-size:11px;font-weight:600;letter-spacing:.22em;text-transform:uppercase;color:var(--a);margin-bottom:14px;}}
h1{{font-family:'Syne',sans-serif;font-size:clamp(36px,5vw,52px);font-weight:800;line-height:1.05;color:var(--w);max-width:720px;margin:0 auto 18px;letter-spacing:-.02em;}}
h1 span{{color:var(--a);}}
.hero p{{color:var(--mid);font-size:15px;max-width:560px;margin:0 auto;line-height:1.65;}}
.posts{{max-width:1100px;margin:0 auto;padding:48px 5%;display:grid;grid-template-columns:repeat(3,1fr);gap:18px;}}
.post-card{{display:flex;flex-direction:column;background:var(--n3);border:1px solid var(--n4);border-radius:10px;padding:28px 24px;text-decoration:none;color:inherit;transition:transform .25s,border-color .25s;}}
.post-card:hover{{transform:translateY(-4px);border-color:rgba(200,241,53,.4);}}
.post-cat{{font-family:'Syne',sans-serif;font-size:10px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--a);margin-bottom:14px;}}
.post-title{{font-family:'Syne',sans-serif;font-size:18px;font-weight:700;color:var(--w);line-height:1.3;margin-bottom:14px;flex:1;}}
.post-meta{{font-size:11px;color:var(--mid);margin-bottom:12px;letter-spacing:.04em;}}
.post-excerpt{{font-size:13px;color:var(--w2);line-height:1.65;}}
.empty{{text-align:center;padding:80px 5%;color:var(--mid);font-size:14px;}}
footer{{background:var(--n2);border-top:1px solid var(--n4);padding:32px 5%;text-align:center;font-size:12px;color:var(--mid);}}
footer a{{color:var(--a);text-decoration:none;}}
@media(max-width:1024px){{.posts{{grid-template-columns:repeat(2,1fr);}}}}
@media(max-width:600px){{.posts{{grid-template-columns:1fr;}}}}
</style>
</head>
<body>

<nav>
  <a href="../index.html" class="logo">TK <span>Digital</span></a>
  <a href="../index.html" class="nav-back">← Retour au site</a>
</nav>

<div class="hero">
  <div class="eyebrow">Blog · Mises à jour Mon/Wed/Fri</div>
  <h1>Conseils SEO, Google et WhatsApp<br><span>pour les commerces du Nord.</span></h1>
  <p>Guides pratiques, comparatifs honnêtes, calculs transparents. Pour les restaurateurs et barbiers qui veulent reprendre la main sur leur clientèle.</p>
</div>

<div class="posts">
{cards_html if cards_html.strip() else '<div class="empty" style="grid-column:1/-1;">Le premier article arrive bientôt. Passe lundi matin.</div>'}
</div>

<footer>
  © 2026 TK Digital · Tarik · Douai, Nord de France · <a href="../index.html">Retour au site</a>
</footer>

</body>
</html>
"""
    INDEX_BLOG.write_text(html, encoding="utf-8")


def generate_sitemap(all_articles):
    """Génère sitemap.xml à la racine du repo, listant toutes les pages SEO."""
    today = datetime.date.today().isoformat()
    base = "https://tar5950.github.io/tk-digital"

    static_pages = [
        {"loc": f"{base}/", "lastmod": today, "priority": "1.0", "changefreq": "weekly"},
        {"loc": f"{base}/restaurateurs.html", "lastmod": today, "priority": "0.9", "changefreq": "weekly"},
        {"loc": f"{base}/barbiers.html", "lastmod": today, "priority": "0.9", "changefreq": "weekly"},
        {"loc": f"{base}/blog/", "lastmod": today, "priority": "0.8", "changefreq": "daily"},
        {"loc": f"{base}/blog/auteur/tarik.html", "lastmod": today, "priority": "0.7", "changefreq": "monthly"},
    ]

    article_entries = ""
    for art in all_articles:
        url = f"{base}/blog/articles/{art['date']}-{art['slug']}.html"
        article_entries += f'\n  <url>\n    <loc>{url}</loc>\n    <lastmod>{art["date"]}</lastmod>\n    <priority>0.7</priority>\n    <changefreq>monthly</changefreq>\n  </url>'

    static_entries = ""
    for p in static_pages:
        static_entries += f'\n  <url>\n    <loc>{p["loc"]}</loc>\n    <lastmod>{p["lastmod"]}</lastmod>\n    <priority>{p["priority"]}</priority>\n    <changefreq>{p["changefreq"]}</changefreq>\n  </url>'

    sitemap = f"""<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{static_entries}{article_entries}
</urlset>
"""
    sitemap_path = ROOT / "sitemap.xml"
    sitemap_path.write_text(sitemap, encoding="utf-8")
    log(f"✅ Sitemap regenerated ({len(all_articles)} articles + {len(static_pages)} static pages)")

    # robots.txt avec lien sitemap
    robots = f"""User-agent: *
Allow: /

Sitemap: {base}/sitemap.xml
"""
    (ROOT / "robots.txt").write_text(robots, encoding="utf-8")


def gather_published_articles():
    """Scanne /blog/articles/ et extrait métadonnées de chaque article."""
    arts = []
    if not ARTICLES.exists():
        return arts
    for f in sorted(ARTICLES.glob("*.html")):
        m = re.match(r"(\d{4}-\d{2}-\d{2})-(.+)\.html$", f.name)
        if not m:
            continue
        date_str, slug = m.group(1), m.group(2)
        try:
            html = f.read_text(encoding="utf-8")
            title_m = re.search(r"<title>(.+?)</title>", html)
            desc_m = re.search(r'<meta name="description" content="(.+?)"', html)
            cat_m = re.search(r'data-category="([^"]+)"', html)
            time_m = re.search(r"⏱️ (\d+) min de lecture", html)
            arts.append({
                "date": date_str,
                "slug": slug,
                "title": (title_m.group(1).split(" | ")[0] if title_m else slug),
                "excerpt": (desc_m.group(1) if desc_m else "")[:180],
                "category": (cat_m.group(1) if cat_m else "general"),
                "reading_time": int(time_m.group(1)) if time_m else 4,
            })
        except Exception as e:
            log(f"⚠️ Failed to parse {f.name}: {e}")
    return arts


# ─────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────
def main():
    log("Starting article generation")

    if not GEMINI_API_KEY:
        log("❌ GEMINI_API_KEY missing in env")
        sys.exit(1)

    briefs = load_json(BRIEFS_FILE)
    personas = load_json(PERSONAS_FILE)

    published_slugs = already_published_slugs()
    log(f"Already published: {len(published_slugs)} articles")

    topic = pick_topic(briefs, published_slugs)
    if not topic:
        log("✅ All topics already published. Nothing to do today.")
        # Régénère quand même l'index au cas où
        update_blog_index(briefs, gather_published_articles())
        return

    log(f"Picked topic: {topic['slug']} (category: {topic['category']})")

    prompt = build_prompt(topic, personas)

    # Appel Gemini avec retry simple
    raw = None
    for attempt in range(1, 4):
        try:
            log(f"Calling Gemini (attempt {attempt}/3)…")
            raw = call_gemini(prompt)
            break
        except Exception as e:
            log(f"Attempt {attempt} failed: {e}")
            if attempt == 3:
                log("❌ Gemini failed 3 times. Aborting.")
                sys.exit(1)

    # Parse JSON
    try:
        article = json.loads(raw)
    except json.JSONDecodeError:
        # Tentative de cleanup ```json ... ```
        cleaned = re.sub(r"^```(?:json)?\s*", "", raw.strip())
        cleaned = re.sub(r"\s*```\s*$", "", cleaned)
        article = json.loads(cleaned)

    # Validation garde-fous
    ok, reason = validate_article(article)
    if not ok:
        log(f"❌ Validation failed: {reason}")
        log(f"Article preview: {json.dumps(article, ensure_ascii=False)[:500]}")
        sys.exit(1)

    log(f"✅ Article validated: {article['title']}")

    # Récupère les articles existants AVANT de créer le nouveau (pour internal linking)
    existing_articles = gather_published_articles()
    related = find_related_articles(topic, existing_articles, limit=3)
    if related:
        log(f"🔗 Related articles for internal linking: {[a['slug'] for a in related]}")

    # Génère le HTML
    date_str = datetime.date.today().isoformat()
    filename = f"{date_str}-{topic['slug']}.html"
    filepath = ARTICLES / filename
    html = render_article_html(article, topic, date_str, related_articles=related)
    filepath.write_text(html, encoding="utf-8")
    log(f"✅ Article written: {filepath}")

    # Update index blog (avec le nouvel article inclus)
    all_articles = gather_published_articles()
    update_blog_index(briefs, all_articles)
    log(f"✅ Blog index updated ({len(all_articles)} articles total)")

    # Update sitemap.xml + robots.txt
    generate_sitemap(all_articles)

    log("Done.")


if __name__ == "__main__":
    main()
