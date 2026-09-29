/* Mister Grill — données de la carte (prix issus des planches menu).
   Pour modifier un prix / ajouter un plat : éditer ce fichier uniquement. */

window.MG_CONFIG = {
  name: "Mister Grill",
  // Numéro WhatsApp de commande au format international sans + ni espaces (ex: 33612345678).
  // Vide = WhatsApp demandera à quel contact envoyer.
  whatsapp: "",
  phone: "",
  address: "22 rue Chaligny, 75012 Paris",
  mapsUrl: "https://www.google.com/maps/search/?api=1&query=Mister+Grill+22+rue+Chaligny+75012+Paris",
  instagram: "https://www.instagram.com/mistergrillofficiel/",
  // Lien "laisser un avis" Google (idéalement https://g.page/r/<ID>/review)
  googleReviewUrl: "https://www.google.com/maps/search/?api=1&query=Mister+Grill+22+rue+Chaligny+75012+Paris",
  // Carte de fidélité : 1 tampon par commande, récompense au palier
  loyalty: { goal: 10, reward: "Ta 10e commande : un menu Classique offert" },
  // Horaires : [jour 0=dim..6=sam] -> [ouverture, fermeture] en minutes (1440 = minuit)
  hours: { 0: [660, 1440], 1: [660, 1440], 2: [660, 1440], 3: [660, 1440], 4: [660, 1440], 5: [840, 1440], 6: [660, 1440] },
  modes: ["À emporter", "Sur place"],
};

(function () {
  const DRINKS = ["Coca-Cola", "Coca-Cola Zéro", "Fanta", "Sprite", "Ice Tea", "Oasis Tropical", "Eau"];
  const SAUCES = ["Blanche", "Algérienne", "Samouraï", "Barbecue", "Ketchup", "Mayonnaise", "Harissa", "Andalouse", "Biggy", "Curry"];
  const PAINS = ["Pain maison", "Pain panini", "Galette tortilla"];

  const one = (id, label, choices, required = true) => ({ id, label, type: "one", required, choices: choices.map(c => typeof c === "string" ? { n: c, p: 0 } : c) });
  const many = (id, label, choices, max) => ({ id, label, type: "many", max, choices });

  const MENU = [one("drink", "Boisson du menu", DRINKS)];
  const SANDWICH = [one("pain", "Pain au choix", PAINS), one("sauce", "Sauce au choix", SAUCES), one("drink", "Boisson du menu", DRINKS)];
  const FRITES_SUP = [many("sup", "Suppléments", [{ n: "Cheddar", p: 1 }, { n: "Cheddar crispy oignons", p: 1.5 }, { n: "Cheddar bacon", p: 2 }], 1)];

  const I = (id, name, price, desc, extra = {}) => ({ id, name, price, desc, ...extra, img: "img/" + (extra.img || id + ".jpg") });

  window.MG_MENU = [
    {
      id: "offres", title: "Offres", sub: "Les bons plans du moment", items: [
        I("menu-etudiant", "Menu Étudiant", 8.9, "Burger, sandwich ou wrap + frites + canette. Du lundi au vendredi de 11h à 15h, hors vacances et jours fériés.", {
          img: "promo-etudiant.jpg", badge: "Étudiant", window: { days: [1, 2, 3, 4, 5], from: 660, to: 900 },
          opts: [one("plat", "Ton plat", ["Burger", "Sandwich", "Wrap tenders"]), one("drink", "Boisson", DRINKS)]
        }),
      ]
    },
    {
      id: "smash", title: "Smash Burger", sub: "Servis avec frites + boisson", items: [
        I("smash-pepper", "Smash Pepper", 13.9, "4 steaks smashés, 4 cheddars, salade, tomates, oignons crispy, cornichons et sauce pepper.", { opts: MENU, badge: "XXL" }),
        I("crunchy-smash", "Crunchy Smash", 12.5, "Poulet crunchy, cheddars, salade, tomates, oignons crispy, cornichons et sauce maison.", { opts: MENU }),
        I("smash-bacon", "Smash Bacon", 11.5, "2 steaks smashés, 2 cheddars, bacon, tomates, oignons crispy, salade, cornichons et sauce smash.", { opts: MENU }),
        I("smash-raclette", "Smash Raclette", 12.5, "2 steaks smashés, 2 cheddars, raclette, lardons, salade, tomates, oignons crispy, cornichons et sauce smash.", { opts: MENU }),
        I("smash-crispy", "Smash Crispy", 11.5, "1 steak smashé, 1 tender crispy, oignons crispy, salade, tomates, cornichons et sauce barbecue.", { opts: MENU }),
        I("smash-chevre-miel", "Smash Chèvre Miel", 12.5, "2 steaks smashés, 2 cheddars, fromage de chèvre, miel, noix, salade, tomates, oignons crispy, cornichons et sauce smash.", { opts: MENU }),
      ]
    },
    {
      id: "homemade", title: "Home Made Burger", sub: "Steak 150 g façon boucher · servis avec frites + boisson", items: [
        I("hm-chevre-miel", "Chèvre Miel Burger", 13.5, "Steak 150 g façon boucher, cheddar, chèvre miel, salade, tomates confites, oignons caramélisés, cornichons.", { opts: MENU, badge: "Signature" }),
        I("hm-montagnard", "Montagnard Burger", 12.9, "Escalope de poulet braisé, cheddar, lardon, raclette, salade, tomates confites, oignons caramélisés, cornichons, sauce maison.", { opts: MENU }),
        I("hm-american", "American Burger", 11.9, "Steak 150 g façon boucher, cheddar, bacon américain, salade, tomates confites, oignons caramélisés, cornichons, sauce Biggy.", { opts: MENU }),
        I("hm-frenchy", "Frenchy Burger", 12.9, "Steak 150 g façon boucher, cheddar, bacon américain, raclette, galette de pommes de terre, salade, tomates confites, oignons caramélisés, cornichons, sauce smoky.", { opts: MENU }),
        I("hm-braiser", "Braiser Burger", 11.9, "Escalope braisée, cheddar, bacon américain, salade, tomates confites, oignons caramélisés, sauce classique.", { opts: MENU }),
        I("hm-avocado", "Avocado Burger", 13.9, "Steak 150 g façon boucher, œuf, cheddar, bacon américain, avocat, salade, tomates confites, oignons caramélisés, sauce Biggy.", { opts: MENU }),
        I("hm-monster", "Monster Burger", 13.9, "Steak 150 g façon boucher, escalope braisée, cheddar, bacon américain, salade, tomates confites, oignons caramélisés.", { opts: MENU }),
        I("hm-bleu", "Bleu Burger", 13.5, "Steak 150 g façon boucher, cheddar, salade, tomates confites, oignons caramélisés, cornichons.", { opts: MENU }),
        I("whooper", "Whooper", 8.9, "Le grand classique flame-grilled, en simple, double ou triple.", {
          opts: [one("size", "Format", [{ n: "Simple", p: 0 }, { n: "Double", p: 2 }, { n: "Triple", p: 4 }]), ...MENU]
        }),
      ]
    },
    {
      id: "classique", title: "Classique Burger", sub: "Servis avec frites + boisson", items: [
        I("cl-double-cheese", "Double Cheese", 6.9, "2 steaks 45 g, oignons, cornichons et 2 cheddars.", { opts: MENU }),
        I("cl-chicken", "Chicken Burger", 7.9, "Poulet pané, salade, cheddar et sauce chicken.", { opts: MENU }),
        I("cl-big-crousty", "Big Crousty Burger", 8.5, "Steak 90 g, galette de pommes de terre, salade, cheddar et sauce mayo & barbecue.", { opts: MENU }),
        I("cl-fish", "Fish Burger", 6.9, "Poisson pané, cheddar et sauce fish.", { opts: MENU }),
        I("cl-chicken-beef", "Chicken Beef", 7.9, "Pain burger sésame, 1 steak 45 g, 1 tender, salade et sauce Big Mac.", { opts: MENU }),
        I("cl-big-m", "Big M Burger", 7.9, "Pain burger sésame, 2 steaks 45 g, salade, cornichons et sauce Big Mac.", { opts: MENU }),
        I("cl-giant", "Giant Burger", 7.5, "2 steaks 45 g, salade, oignons, cheddar et sauce giant.", { opts: MENU }),
        I("cl-royal", "Royal Cheese", 7.9, "Steak 90 g, salade, oignons rouges, cornichons, cheddar et sauce royal (ketchup, moutarde & poivre).", { opts: MENU }),
        I("cl-tower", "Tower Burger", 8.5, "Poulet pané, galette de pommes de terre, cheddar et sauce mayo & barbecue.", { opts: MENU }),
      ]
    },
    {
      id: "sandwich", title: "Sandwichs", sub: "Pain au choix · sauce au choix · frites + boisson", items: [
        I("sw-phenomene", "Sandwich Phénomène", 9.9, "Le best-seller de la maison : poulet mariné, cordon bleu, cheddar fondu, salade, tomates.", { opts: SANDWICH, badge: "Best-seller" }),
        I("sw-boursin", "Sandwich Boursin", 9.9, "Escalope, crème fraîche, Boursin, cheddar, salade, tomate, oignons.", { opts: SANDWICH }),
        I("sw-tandoori", "Chicken Tandoori", 9.5, "Poulet tandoori et cheddar, salade, tomate, oignons.", { opts: SANDWICH }),
        I("sw-croustillant", "Sandwich Croustillant", 9.9, "2 steaks, 2 tenders, cheddar, salade, tomate, oignons.", { opts: SANDWICH }),
        I("sw-radical", "Sandwich Radical", 9.9, "2 steaks, cordon bleu et cheddar, salade, tomate, oignons.", { opts: SANDWICH }),
        I("sw-curry", "Chicken Curry", 9.5, "Poulet curry, cheddar, salade, tomate, oignons.", { opts: SANDWICH }),
        I("sw-forestier", "Sandwich Forestier", 9.9, "Escalope, cheddar, crème fraîche, champignons, salade, tomate, oignons.", { opts: SANDWICH }),
        I("sw-farmer", "Sandwich Farmer", 9.9, "Steak, escalope, Boursin, œuf, cheddar, salade, tomate, oignons.", { opts: SANDWICH }),
        I("sw-escalope", "Sandwich Escalope", 9.5, "Escalope, cheddar, salade, tomate, oignons.", { opts: SANDWICH }),
        I("sw-savoyard", "Sandwich Savoyard", 9.9, "Escalope, crème fraîche, lardons, raclette, cheddar, salade, tomate, oignons.", { opts: SANDWICH }),
        I("sw-auvergnat", "Sandwich Auvergnat", 10.9, "Steak du boucher 150 g, bleu fourme d'Ambert, aubergine grillée, cheddar, salade, tomate, oignons.", { opts: SANDWICH }),
        I("sw-country", "Sandwich Country", 9.9, "3 steaks, bacon de dinde, cheddar, salade, tomate, oignons.", { opts: SANDWICH }),
        I("sw-wrap", "Wrap Tenders", 9.5, "Pain tortilla, tenders, galette de pommes de terre, double fromage, salade, tomate, oignons.", { opts: [one("sauce", "Sauce au choix", SAUCES), one("drink", "Boisson du menu", DRINKS)] }),
      ]
    },
    {
      id: "brasserie", title: "Brasserie", sub: "Les assiettes généreuses", items: [
        I("riz-curry", "Riz Poulet Curry", 11.5, "Riz blanc, émincé de poulet sauce curry crémeuse."),
        I("riz-tandoori", "Riz Poulet Tandoori", 11.5, "Riz blanc, poulet mariné tandoori."),
        I("riz-butter", "Riz Butter Chicken", 11.5, "Riz blanc, poulet sauce butter chicken."),
        I("riz-crousty", "Riz Poulet Crousty", 8.9, "Riz, poulet crousty, sauce maison."),
        I("steak-cheval", "Steak à Cheval", 12.5, "Steak, œuf au plat, frites, salade et sauce."),
        I("fish-chips", "Fish & Chips", 12.9, "Poisson pané, frites, salade et sauce."),
        I("pave-saumon", "Pavé de Saumon", 13.9, "Pavé de saumon, riz, légumes et sauce."),
        I("esc-normande", "Escalope Normande", 11.9, "Escalope, sauce normande crème & champignons, pâtes."),
        I("esc-gorgonzola", "Escalope Gorgonzola", 12.5, "Escalope, sauce gorgonzola, pâtes."),
        I("esc-parisienne", "Escalope Parisienne", 12.9, "Escalope, sauce parisienne, pâtes."),
        I("esc-parmigiana", "Escalope Gratinée Parmigiana", 13.5, "Escalope gratinée façon parmigiana, pâtes."),
        I("esc-montagnarde", "Escalope Gratinée Montagnarde", 13.5, "Escalope gratinée raclette & lardons, pâtes."),
        I("esc-chevre-miel", "Escalope Gratinée Chèvre Miel", 13.5, "Escalope gratinée au chèvre et miel, pâtes."),
      ]
    },
    {
      id: "pasta", title: "Pasta", sub: "Penne gourmandes", items: [
        I("pates-bolo", "Pâtes Bolognaise", 8.9, "Penne, sauce bolognaise, parmesan."),
        I("pates-carbo", "Pâtes Carbonara", 8.9, "Penne, crème, lardons, parmesan."),
        I("pates-forestiere", "Pâtes Forestière", 8.9, "Penne, crème, champignons, poulet."),
        I("pates-4fromages", "Pâtes 4 Fromages", 8.9, "Penne, sauce aux quatre fromages."),
        I("pates-saumon", "Pâtes Saumon", 9.5, "Penne, crème, saumon."),
      ]
    },
    {
      id: "gratins", title: "Gratins", sub: "Gratin dauphinois garni", items: [
        I("gratin", "Gratin", 9.9, "Gratin dauphinois gratiné au four, garniture au choix.", {
          opts: [one("garniture", "Garniture", [
            { n: "Poulet tandoori", p: 0 }, { n: "Poulet curry", p: 0 }, { n: "Bœuf haché", p: 0 }, { n: "Lardon", p: 0 }, { n: "Jambon de dinde", p: 0 },
            { n: "Poulet Boursin", p: 1 }, { n: "Savoyard", p: 1 }, { n: "Montagnard", p: 1 }, { n: "Forestier", p: 1 }, { n: "Bœuf d'Ambert", p: 1 }, { n: "Saumon fumé", p: 1 },
          ])]
        }),
      ]
    },
    {
      id: "salades", title: "Salades", sub: "Fraîches et copieuses", items: [
        I("salade-cesar", "Salade César", 8.9, "Salade, poulet, croûtons, parmesan, sauce César."),
        I("salade-saumon", "Salade Saumon", 9.5, "Salade, saumon, crudités, sauce."),
        I("salade-chevre", "Salade Chèvre Chaud", 8.9, "Salade, toasts de chèvre chaud, crudités."),
        I("salade-avocat", "Salade Avocat Crevettes", 9.5, "Salade, avocat, crevettes, crudités."),
      ]
    },
    {
      id: "frenchies", title: "Frenchies", sub: "Nos frites", items: [
        I("frites-classique", "Frites Classique", 2.9, "Frites dorées et croustillantes.", { opts: FRITES_SUP }),
        I("frites-maison", "Frites Maison", 3.5, "Frites maison assaisonnées.", { opts: FRITES_SUP }),
      ]
    },
    {
      id: "extras", title: "Extras", sub: "À partager… ou pas", items: [
        I("x-cheese", "Cheese", 2.9, "Cheeseburger."),
        I("x-croque", "Croque Monsieur", 3.9, "Croque dinde & fromage gratiné."),
        I("x-hotdog", "Hot-Dog", 3.9, "Saucisse, cheddar, oignons crispy."),
        I("x-jalapenos", "Jalapeños ×4", 3.9, "Jalapeños panés au fromage."),
        I("x-mozza", "Mozza Sticks ×4", 3.9, "Bâtonnets de mozzarella panés."),
        I("x-tenders", "Tenders ×3", 3.9, "Filets de poulet croustillants."),
        I("x-nuggets", "Nuggets ×5", 3.9, "Nuggets de poulet."),
        I("x-camembert", "Bouchées Camembert ×4", 3.9, "Bouchées de camembert panées."),
      ]
    },
    {
      id: "enfant", title: "Menu Enfant", sub: "Avec Capri-Sun et Kinder Surprise", items: [
        I("menu-enfant", "Menu Enfant", 6.9, "Cheeseburger ou 5 nuggets, servis avec frites, Capri-Sun et Kinder Surprise !", {
          opts: [one("plat", "Au choix", ["Cheeseburger", "5 Nuggets"])]
        }),
      ]
    },
    {
      id: "desserts", title: "Desserts & Boissons", sub: "Laissez-vous tenter", items: [
        I("d-waffle-cup", "Waffle Cup", 3.9, "Bubble waffle en cup, chantilly, fruits et nappage.", { badge: "Nouveau" }),
        I("d-waffle-cone", "Waffle Cone", 3.9, "Bubble waffle en cornet, garni et nappé."),
        I("d-milkshake", "Milkshake", 4.5, "Milkshake gourmand, chantilly et nappage."),
        I("d-smoothie", "Smoothie", 4.9, "Smoothie aux fruits frais."),
        I("d-pain-perdu", "Pain Perdu", 3.9, "Pain perdu caramélisé, boule de glace."),
        I("d-tiramisu", "Tiramisu", 3.5, "Tiramisu maison.", { opts: [one("parfum", "Parfum", ["Spéculoos", "Oreo", "Caramel", "Nutella"])] }),
        I("d-tiramisu-barq", "Tiramisu Barquette", 5.9, "Grande barquette de tiramisu à partager.", { opts: [one("parfum", "Parfum", ["Caramel", "Nutella"])] }),
        I("d-cookie", "Cookie", 2.9, "Cookie moelleux au cœur fondant."),
      ]
    },
  ];

  // "Les + commandés" (à ajuster avec les vraies ventes)
  window.MG_BEST = ["sw-phenomene", "smash-bacon", "hm-chevre-miel", "crunchy-smash", "cl-big-crousty", "sw-wrap", "d-waffle-cone"];
  // Suggestions "On ajoute ?" dans le panier (plats sans option obligatoire)
  window.MG_UPSELL = ["frites-maison", "x-tenders", "x-mozza", "d-cookie", "d-milkshake", "d-pain-perdu", "x-nuggets"];

  window.MG_PROMOS = [
    { img: "img/promo-etudiant.jpg", title: "Menu Étudiant 8,90 €", text: "Lun → Ven · 11h-15h", target: "offres" },
    { img: "img/promo-milkshakes.jpg", title: "Milkshakes & Smoothies", text: "À partir de 4,50 €", target: "desserts" },
    { img: "img/promo-desserts.jpg", title: "Nos super desserts", text: "À partir de 3,90 €", target: "desserts" },
  ];
})();
