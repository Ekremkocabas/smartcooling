// netlify/functions/meta-leads-sync.js  (v2, 3/11/2026: NL-veldnamen, naam-fix + herstel bestaande leads)
// v3.2 (25/11/2026): gemeente nooit meer uit de vraag "wanneer plaatsen" (gaf "zo_snel_mogelijk" als stad);
//   formulieren zonder veld Plaats krijgen de gemeente via de postcode; foute leads worden automatisch hersteld.
// Scheduled function (elke 10 min): haalt nieuwe leads op uit Meta-leadformulieren en verwerkt ze
// precies zoals een website-aanvraag: lead in Odoo + lead-mail via Brevo (lib/lead.js).
// Enkel de formulieren in META_FORM_IDS worden gesynchroniseerd (andere Meta-leads blijven zoals ze zijn).
//
// Netlify environment variables (in de Netlify-UI, NOOIT in dit bestand):
//   META_ACCESS_TOKEN  systeemgebruiker-token (Odoo Integratie, Smart Cooling), recht: leads_retrieval
//   META_PAGE_ID       942119625645272 (pagina Smart Cooling)
//   META_FORM_IDS      komma-gescheiden lijst van leadformulier-ID's, bv. "1234567890"
//   + de bestaande ODOO_* en BREVO_* variabelen.
// Dubbels: elke lead krijgt "Meta lead-ID: <id>" in de beschrijving; staat die al in Odoo, dan wordt hij overgeslagen.

const { processLead } = require("./lib/lead.js");
// v4 (27/11/2026): testweek AircoFlowPro — na de volledige Odoo-ronde gaan dezelfde leads ook naar de AFP-webhook (lib/afp.js,
//   env AFP_LEADS_URL + AFP_LEADS_KEY; ontbreken ze, dan verandert er niets). Odoo en de lead-mail blijven exact zoals ze waren.
//   Netlify Blobs "afp-leads" onthoudt welke Meta-leads al in AFP staan (lukt AFP niet, dan volgende run opnieuw).
let afp = null;
try { afp = require("./lib/afp.js"); } catch (e) { console.error("afp module niet geladen (Odoo werkt gewoon): " + e.message); }
function afpStore(event) { try { const { getStore, connectLambda } = require("@netlify/blobs"); if (event) connectLambda(event); return getStore("afp-leads"); } catch (e) { console.warn("afp-opslag niet beschikbaar:", e.message); return null; } }
const GRAPH = "https://graph.facebook.com/v21.0";
const LOOKBACK_H = 48; // elke run kijkt 48 u terug; dubbels worden via Odoo herkend

async function graph(path, token) {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`${GRAPH}/${path}${sep}access_token=${encodeURIComponent(token)}`);
  const j = await r.json();
  if (j.error) throw new Error("Meta: " + (j.error.message || JSON.stringify(j.error)));
  return j;
}

async function odoo() {
  const URL = process.env.ODOO_URL, DB = process.env.ODOO_DB, LOGIN = process.env.ODOO_LOGIN, KEY = process.env.ODOO_API_KEY;
  const rpc = async (service, method, args) => {
    const res = await fetch(`${URL}/jsonrpc`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args } }) });
    const j = await res.json();
    if (j.error) throw new Error((j.error.data && j.error.data.message) || j.error.message);
    return j.result;
  };
  const uid = await rpc("common", "authenticate", [DB, LOGIN, KEY, {}]);
  return (model, method, args, kw) => rpc("object", "execute_kw", [DB, uid, KEY, model, method, args, kw || {}]);
}
async function odooHasLead(call, metaId) {
  const n = await call("crm.lead", "search_count", [[["description", "ilike", "Meta lead-ID: " + metaId], ["active", "in", [true, false]]]]);
  return n > 0;
}

// Meta field_data [{name, values:[...]}] -> plat object
function fields(lead) {
  const o = {};
  for (const f of lead.field_data || []) o[f.name] = (f.values || []).join(", ");
  return o;
}
// Veldnamen kunnen Engels (full_name, email, ...) of Nederlands (volledige_naam, e-mailadres, ...) zijn.
// Eerst exacte namen, dan "bevat" met uitsluitingen (bv. "straatnaam" bevat "naam" maar is geen naam).
const norm = (k) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
function pick(o, exact, contains = [], exclude = []) {
  const keys = Object.keys(o);
  for (const e of exact) { const k = keys.find((x) => norm(x) === norm(e)); if (k && o[k]) return o[k]; }
  for (const c of contains) {
    const k = keys.find((x) => norm(x).includes(norm(c)) && !exclude.some((ex) => norm(x).includes(norm(ex))));
    if (k && o[k]) return o[k];
  }
  return "";
}
const FIELDS = {
  first: [["first_name", "voornaam"], []],
  last: [["last_name", "achternaam", "familienaam"], []],
  full: [["full_name", "volledige_naam", "naam", "name"], ["volledigenaam", "fullname"], ["straat", "street", "bedrijf", "company"]],
  email: [["email", "e-mailadres", "emailadres"], ["mail"]],
  phone: [["phone_number", "phone", "telefoonnummer", "telefoon", "gsm"], ["phone", "telefoon", "gsm"]],
  street: [["street_address", "straat_en_nummer", "straatnaam_en_nummer", "adres"], ["street", "straat"], ["mail"]],
  zip: [["post_code", "postcode", "zip_code", "zip"], ["post", "zip"]],
  // "plaats" enkel exact: "Wanneer wilt u de airco laten plaatsen?" is GEEN gemeente
  city: [["city", "plaats", "gemeente", "woonplaats", "stad"], ["city", "gemeente", "woonplaats"], ["wanneer", "plaatsen", "plaatsing", "ruimte", "bellen"]],
};
// Belgische postcode -> (hoofd)gemeente, voor formulieren zonder veld Plaats (bron: spatie/belgian-cities-geocoded)
const PC = Object.fromEntries("1000:Brussel|1020:Laken|1030:Schaarbeek|1040:Etterbeek|1050:Elsene|1060:Sint-Gillis|1070:Anderlecht|1080:Sint-Jans-Molenbeek|1081:Koekelberg|1082:Sint-Agatha-Berchem|1083:Ganshoren|1090:Jette|1120:Neder-Over-Heembeek|1130:Haren|1140:Evere|1150:Sint-Pieters-Woluwe|1160:Oudergem|1170:Watermaal-Bosvoorde|1180:Ukkel|1190:Vorst|1200:Sint-Lambrechts-Woluwe|1210:Sint-Joost-Ten-Noode|1300:Limal|1301:Bierges|1310:La Hulpe|1315:Glimes|1320:Beauvechain|1325:Bonlez|1330:Rixensart|1331:Rosières|1332:Genval|1340:Ottignies-Louvain-La-Neuve|1341:Céroux-Mousty|1342:Limelette|1348:Louvain-La-Neuve|1350:Orp-Jauche|1357:HÉlÉcine|1360:Malèves-Sainte-Marie-Wastines|1367:Geest-Gérompont-Petit-Rosière|1370:Jodoigne-Souveraine|1380:Lasne-Chapelle-Saint-Lambert|1390:Archennes|1400:Monstreux|1401:Baulers|1402:Thines|1404:Bornival|1410:Waterloo|1420:Braine-L'alleud|1421:Ophain-Bois-Seigneur-Isaac|1428:Lillois-Witterzée|1430:Rebecq-Rognon|1435:Corbais|1440:Braine-Le-ChÂteau|1450:Chastre-Villeroux-Blanmont|1457:Walhain-Saint-Paul|1460:Ittre|1461:Haut-Ittre|1470:Baisy-Thy|1471:Loupoigne|1472:Vieux-Genappe|1473:Glabais|1474:Ways|1476:Houtain-Le-Val|1480:Clabecq|1490:Court-Saint-Etienne|1495:Marbais|1500:Halle|1501:Buizingen|1502:Lembeek|1540:Herfelingen|1541:Sint-Pieters-Kapelle|1547:Bever|1560:Hoeilaart|1570:Galmaarden|1600:Oudenaken|1601:Ruisbroek|1602:Vlezenbeek|1620:Drogenbos|1630:Linkebeek|1640:Sint-Genesius-Rode|1650:Beersel|1651:Lot|1652:Alsemberg|1653:Dworp|1654:Huizingen|1670:Bogaarden|1671:Elingen|1673:Beert|1674:Bellingen|1700:Dilbeek|1701:Itterbeek|1702:Groot-Bijgaarden|1703:Schepdaal|1730:Asse|1731:Relegem|1733:Highco Data|1740:Ternat|1741:Wambeek|1742:Sint-Katherina-Lombeek|1745:Mazenzele|1750:Sint-Kwintens-Lennik|1755:Gooik|1760:Onze-Lieve-Vrouw-Lombeek|1761:Borchtlombeek|1770:Liedekerke|1780:Wemmel|1785:Brussegem|1790:Affligem|1800:Peutie|1804:Cargovil|1818:Vtm|1820:Melsbroek|1830:Machelen|1831:Diegem|1840:Londerzeel|1850:Grimbergen|1851:Humbeek|1852:Beigem|1853:Strombeek-Bever|1860:Meise|1861:Wolvertem|1880:Kapelle-Op-Den-Bos|1910:Berg|1930:Nossegem|1931:Brucargo|1932:Sint-Stevens-Woluwe|1933:Sterrebeek|1934:Office Exchange Brussels Airport Remailing|1935:Corporate Village|1950:Kraainem|1970:Wezembeek-Oppem|1980:Eppegem|1981:Hofstade|1982:Elewijt|2000:Antwerpen|2018:Antwerpen|2020:Antwerpen|2030:Antwerpen|2040:Antwerpen|2050:Antwerpen|2060:Antwerpen|2070:Zwijndrecht|2099:Antwerpen X|2100:Deurne|2110:Wijnegem|2140:Borgerhout|2150:Borsbeek|2160:Wommelgem|2170:Merksem|2180:Ekeren|2200:Herentals|2220:Heist-op-den-Berg|2221:Booischot|2222:Heist-op-den-Berg|2223:Schriek|2230:Herselt|2235:Hulshout|2240:Zandhoven|2242:Pulderbos|2243:Pulle|2250:Olen|2260:Westerlo|2270:Herenthout|2275:Lille|2280:Grobbendonk|2288:Bouwel|2290:Vorselaar|2300:Turnhout|2310:Rijkevorsel|2320:Hoogstraten|2321:Meer|2322:Minderhout|2323:Wortel|2328:Meerle|2330:Merksplas|2340:Beerse|2350:Vosselaar|2360:Oud-Turnhout|2370:Arendonk|2380:Ravels|2381:Weelde|2382:Poppel|2387:Baarle-Hertog|2390:Malle|2400:Mol|2430:Laakdal|2431:Laakdal|2440:Geel|2450:Meerhout|2460:Kasterlee|2470:Retie|2480:Dessel|2490:Balen|2491:Olmen|2500:Lier|2520:Ranst|2530:Boechout|2531:Vremde|2540:Hove|2547:Lint|2550:Kontich|2560:Nijlen|2570:Duffel|2580:Putte|2590:Berlaar|2600:Berchem|2610:Wilrijk|2620:Hemiksem|2627:Schelle|2630:Aartselaar|2640:Mortsel|2650:Edegem|2660:Hoboken|2800:Mechelen|2801:Heffen|2811:Mechelen|2812:Muizen|2820:Bonheiden|2830:Willebroek|2840:Rumst|2845:Niel|2850:Boom|2860:Sint-Katelijne-Waver|2861:Onze-Lieve-Vrouw-Waver|2870:Puurs-Sint-Amands|2870,2890:Puurs-Sint-Amands|2880:Bornem|2890:Puurs-Sint-Amands|2900:Schoten|2910:Essen|2920:Kalmthout|2930:Brasschaat|2940:Stabroek|2950:Kapellen|2960:Brecht|2970:Schilde|2980:Zoersel|2990:Wuustwezel|3000:Leuven|3001:Heverlee|3010:Kessel Lo|3012:Wilsele|3018:Wijgmaal|3020:Herent|3040:Huldenberg|3050:Oud-Heverlee|3051:Sint-Joris-Weert|3052:Blanden|3053:Haasrode|3054:Vaalbeek|3060:Bertem|3061:Leefdaal|3070:Kortenberg|3071:Erps-Kwerps|3078:Kortenberg|3080:Tervuren|3090:Overijse|3110:Rotselaar|3111:Wezemaal|3118:Werchter|3120:Tremelo|3128:Baal|3130:Begijnendijk|3140:Keerbergen|3150:Haacht|3190:Boortmeerbeek|3191:Hever|3200:Aarschot|3201:Langdorp|3202:Rillaar|3210:Lubbeek|3211:Binkom|3212:Pellenberg|3220:Holsbeek|3221:Holsbeek|3270:Scherpenheuvel-Zichem|3271:Scherpenheuvel-Zichem|3272:Scherpenheuvel-Zichem|3290:Diest|3293:Kaggevinne|3294:Molenstede|3300:Tienen|3320:Hoegaarden|3321:Outgaarden|3350:Linter|3360:Bierbeek|3370:Boutersem|3380:Glabbeek|3381:Kapellen|3384:Attenrode|3390:Tielt-Winge|3391:Meensel-Kiezegem|3400:Landen|3401:Landen|3404:Landen|3440:Zoutleeuw|3450:Geetbets|3454:Rummen|3460:Bekkevoort|3461:Molenbeek-Wersbeek|3470:Kortenaken|3471:Hoeleden|3472:Kersbeek-Miskom|3473:Waanrode|3500:Hasselt|3501:Wimmertingen|3510:Hasselt|3511:Hasselt|3512:Stevoort|3520:Zonhoven|3530:Houthalen-Helchteren|3540:Herk-de-Stad|3545:Halen|3550:Heusden-Zolder|3560:Lummen|3570:Alken|3580:Beringen|3581:Beverlo|3582:Koersel|3583:Paal|3590:Diepenbeek|3600:Genk|3620:Lanaken|3621:Rekem|3630:Maasmechelen|3631:Maasmechelen|3640:Kinrooi|3650:Dilsen-Stokkem|3660,3670:Oudsbergen|3665:As|3668:Niel-Bij-As|3670:Oudsbergen|3680:Maaseik|3690:Zutendaal|3700:Tongeren|3717:Herstappe|3720:Kortessem|3721:Vliermaalroot|3722:Wintershoven|3723:Guigoven|3724:Vliermaal|3730:Hoeselt|3732:Schalkhoven|3740:Bilzen|3742:Martenslinde|3746:Hoelbeek|3770:Riemst|3790:Voeren|3791:Remersdaal|3792:Sint-Pieters-Voeren|3793:Teuven|3798:S Gravenvoeren|3800:Sint-Truiden|3803:Sint-Truiden|3806:Velm|3830:Wellen|3831:Herten|3832:Ulbeek|3840:Borgloon|3850:Nieuwerkerken|3870:Heers|3890:Gingelom|3891:Gingelom|3900,3910:Pelt|3910:Sint-Huibrechts-Lille|3920:Lommel|3930:Hamont-Achel|3940:Hechtel-Eksel|3941:Eksel|3945:Ham|3950:Bocholt|3960:Bree|3970:Leopoldsburg|3971:Heppen|3980:Tessenderlo|3990:Peer|4000:Glain|4020:Bressoux|4030:Grivegnee|4031:Angleur|4032:Chênee|4040:Herstal|4041:Milmort|4042:Liers|4050:Chaudfontaine|4051:Vaux-Sous-Chèvremont|4052:Beaufays|4053:Embourg|4075:Csm Liege X|4100:Boncelles|4101:Jemeppe-Sur-Meuse|4102:Ougrée|4120:Ehein|4121:Neuville-En-Condroz|4122:Plainevaux|4130:Esneux|4140:Dolembreux|4141:Louveigné|4160:Anthisnes|4161:Villers-Aux-Tours|4162:Hody|4163:Tavier|4170:Comblain-Au-Pont|4171:Poulseur|4180:Comblain-Fairon|4181:Filot|4190:FerriÈres|4210:Burdinne|4217:HÉron|4218:Couthuin|4219:Acosse|4250:Hollogne-Sur-Geer|4252:Omal|4253:Darion|4254:Ligney|4257:Berloz|4260:Avennes|4261:Latinne|4263:Tourinne|4280:Abolens|4287:Lincent|4300:Bettincourt|4317:Aineffe|4340:Awans|4342:Hognoul|4347:Fexhe-Le-Haut-Clocher|4350:Lamine|4351:Hodeige|4357:Donceel|4360:Bergilers|4367:CrisnÉe|4400:Awirs|4420:Montegnée|4430:Ans|4431:Loncin|4432:Alleur|4450:Juprelle|4451:Voroux-Lez-Liers|4452:Paifve|4453:Villers-Saint-Siméon|4458:Fexhe-Slins|4460:Bierset|4470:Saint-Georges-Sur-Meuse|4480:Clermont-Sous-Huy|4500:Ben-Ahin|4520:Antheit|4530:Fize-Fontaine|4537:Bodegnée|4540:Amay|4550:Nandrin|4557:Soheit-Tinlot|4560:Bois-Et-Borsu|4570:Marchin|4577:Modave|4590:Ellemelle|4600:Lanaye|4601:Argenteau|4602:Cheratte|4606:Saint-André|4607:Berneau|4608:Neufchâteau|4610:Bellaire|4620:FlÉron|4621:Retinne|4623:Magnée|4624:Romsée|4630:Ayeneux|4631:Evegnée|4632:Cérexhe-Heuseux|4633:Melen|4650:Chaineux|4651:Battice|4652:Xhendelesse|4653:Bolland|4654:Charneux|4670:BlÉgny|4671:Barchon|4672:Saint-Remy|4680:Hermée|4681:Hermalle-Sous-Argenteau|4682:Heure-Le-Romain|4683:Vivegnis|4684:Haccourt|4690:Bassenge|4700:Eupen|4701:Kettenis|4710:Lontzen|4711:Walhorn|4720:La Calamine|4721:Neu-Moresnet|4728:Hergenrath|4730:Hauset|4731:Eynatten|4750:Butgenbach|4760:Bullange|4761:Rocherath|4770:AmblÈve|4771:Heppenbach|4780:Recht|4782:Schoenberg|4783:Lommersweiler|4784:Crombach|4790:Burg-Reuland|4791:Thommen|4800:Ensival|4801:Stembert|4802:Heusy|4820:Dison|4821:Andrimont|4830:Limbourg|4831:Bilstain|4834:Goé|4837:Baelen|4840:Welkenraedt|4841:Henri-Chapelle|4845:Jalhay|4850:Montzen|4851:Gemmenich|4852:Hombourg|4860:Cornesse|4861:Soiron|4870:Forêt|4877:Olne|4880:Aubel|4890:Thimister-Clermont|4900:Spa|4910:La Reid|4920:Aywaille|4950:Faymonville|4960:Bellevaux-Ligneuville|4970:Francorchamps|4980:Fosse|4983:Basse-Bodeux|4987:Chevron|4990:Arbrefontaine|5000:Beez|5001:Belgrade|5002:Saint-Servais|5003:Saint-Marc|5004:Bouge|5012:Parlement Wallon|5020:Champion|5021:Boninne|5022:Cognelée|5024:Gelbressée|5030:Beuzet|5031:Grand-Leez|5032:Bossière|5060:Arsimont|5070:Aisemont|5080:Emines|5081:Saint-Denis-Bovesse|5100:Dave|5101:Erpent|5140:Boignée|5150:Floreffe|5170:Arbre|5190:Balâtre|5300:Andenne|5310:Aische-En-Refail|5330:Assesse|5332:Crupet|5333:Sorinne-La-Longue|5334:Florée|5336:Courrière|5340:Faulx-Les-Tombes|5350:Evelette|5351:Haillot|5352:Perwez-Haillot|5353:Goesnes|5354:Jallet|5360:Hamois|5361:Mohiville|5362:Achet|5363:Emptinne|5364:Schaltin|5370:Barvaux-Condroz|5372:Méan|5374:Maffe|5376:Miécret|5377:Baillonville|5380:Bierwart|5500:Anseremme|5501:Lisogne|5502:Thynes|5503:Sorinnes|5504:Foy-Notre-Dame|5520:Anthée|5521:Serville|5522:Falaen|5523:Sommière|5524:Gerin|5530:Dorinne|5537:AnhÉe|5540:HastiÈre|5541:Hastière-Par-Delà|5542:Blaimont|5543:Heer|5544:Agimont|5550:Alle|5555:Baillamont|5560:Ciergnon|5561:Celles|5562:Custinne|5563:Hour|5564:Wanlin|5570:Baronville|5571:Wiesme|5572:Focant|5573:Martouzin-Neuville|5574:Pondrôme|5575:Bourseigne-Neuve|5576:Froidfontaine|5580:Ave-Et-Auffe|5589:Jemelle|5590:Achêne|5600:Fagnolle|5620:Hemptinne-Lez-Florennes|5621:Hanzinelle|5630:Cerfontaine|5640:Biesme|5641:Furnaux|5644:Ermeton-Sur-Biert|5646:Stave|5650:Castillon|5651:Berzée|5660:Brûly-De-Pesche|5670:Dourbes|5680:Doische|6000:Charleroi|6001:Marcinelle|6010:Couillet|6020:Dampremy|6030:Goutroux|6031:Monceau-Sur-Sambre|6032:Mont-Sur-Marchienne|6040:Jumet|6041:Gosselies|6042:Lodelinsart|6043:Ransart|6044:Roux|6060:Gilly|6061:Montignies-Sur-Sambre|6099:Charleroi X|6110:Montigny-Le-Tilleul|6111:Landelies|6120:Cour-Sur-Heure|6140:Fontaine-L'evÊque|6141:Forchies-La-Marche|6142:Leernes|6150:Anderlues|6180:Courcelles|6181:Gouy-Lez-Piéton|6182:Souvret|6183:Trazegnies|6200:Bouffioulx|6210:Frasnes-Lez-Gosselies|6211:Mellet|6220:Fleurus|6221:Saint-Amand|6222:Brye|6223:Wagnelée|6224:Wanfercée-Baulet|6230:Buzet|6238:Liberchies|6240:Farciennes|6250:Aiseau-Presles|6280:Acoz|6440:Boussu-Lez-Walcourt|6441:Erpion|6460:Bailièvre|6461:Virelles|6462:Vaulx-Lez-Chimay|6463:Lompret|6464:Baileux|6470:Sivry-Rance|6500:Barbençon|6511:Strée|6530:Leers-Et-Fosteau|6531:Biesme-Sous-Thuin|6532:Ragnies|6533:Biercée|6534:Gozée|6536:Donstiennes|6540:Lobbes|6542:Sars-La-Buissière|6543:Bienne-Lez-Happart|6560:Bersillies-L'abbaye|6567:Fontaine-Valmont|6590:Momignies|6591:Macon|6592:Monceau-Imbrechies|6593:Macquenoise|6594:Beauwelz|6596:Forge-Philippe|6600:Bastogne|6630:Martelange|6637:Fauvillers|6640:Hompré|6642:Juseret|6660:Houffalize|6661:Mont|6662:Tavigny|6663:Mabompré|6666:Wibrin|6670:Gouvy|6671:Bovigny|6672:Beho|6673:Cherain|6674:Montleban|6680:Amberloup|6681:Lavacherie|6686:Flamierge|6687:Bertogne|6688:Longchamps|6690:Bihain|6692:Petit-Thier|6698:Grand-Halleux|6700:Arlon|6704:Guirsch|6706:Autelbas|6717:Attert|6720:Habay-La-Neuve|6721:Anlier|6723:Habay-La-Vieille|6724:Houdemont|6730:Bellefontaine|6740:Etalle|6741:Vance|6742:Chantemelle|6743:Buzenol|6747:Châtillon|6750:Musson|6760:Bleid|6761:Latour|6762:Saint-Mard|6767:Dampicourt|6769:Gérouville|6780:Hondelange|6781:Sélange|6782:Habergy|6790:Aubange|6791:Athus|6792:Halanzy|6800:Bras|6810:Chiny|6811:Les Bulles|6812:Suxy|6813:Termes|6820:Florenville|6821:Lacuisine|6823:Villers-Devant-Orval|6824:Chassepierre|6830:Bouillon|6831:Noirfontaine|6832:Sensenruth|6833:Ucimont|6834:Bellevaux|6836:Dohan|6838:Corbion|6840:Grandvoir|6850:Carlsbourg|6851:Nollevaux|6852:Maissin|6853:Framont|6856:Fays-Les-Veneurs|6860:Assenois|6870:Arville|6880:Auby-Sur-Semois|6887:Herbeumont|6890:Anloy|6900:Aye|6920:Sohier|6921:Chanly|6922:Halma|6924:Lomprez|6927:Bure|6929:Daverdisse|6940:Barvaux-Sur-Ourthe|6941:Bende|6950:Harsin|6951:Bande|6952:Grune|6953:Ambly|6960:Dochamps|6970:Tenneville|6971:Champlon|6972:Erneuville|6980:Beausaint|6982:Samrée|6983:Ortho|6984:Hives|6986:Halleux|6987:Beffe|6990:Fronville|6997:Amonines|7000:Mons|7010:Shape|7011:Ghlin|7012:Flénu|7020:Maisières|7021:Havre|7022:Harmignies|7024:Ciply|7030:Saint-Symphorien|7031:Villers-Saint-Ghislain|7032:Spiennes|7033:Cuesmes|7034:Obourg|7040:Asquillies|7041:Givry|7050:Erbaut|7060:Horrues|7061:Casteau|7062:Naast|7063:Chaussée-Notre-Dame-Louvignies|7070:Gottignies|7080:Eugies|7090:Braine-Le-Comte|7100:Haine-Saint-Paul|7110:Boussoit|7120:Croix-Lez-Rouveroy|7130:Battignies|7131:Waudrez|7133:Buvrinnes|7134:Epinois|7140:Morlanwelz-Mariemont|7141:Carnières|7160:Chapelle-Lez-Herlaimont|7170:Fayt-Lez-Manage|7180:Seneffe|7181:Arquennes|7190:Ecaussinnes-D'enghien|7191:Ecaussinnes-Lalaing|7300:Boussu|7301:Hornu|7320:Bernissart|7321:Blaton|7322:Ville-Pommeroeul|7330:Saint-Ghislain|7331:Baudour|7332:Neufmaison|7333:Tertre|7334:Hautrage|7340:Colfontaine|7350:Hainin|7370:Blaugies|7380:Baisieux|7382:Audregnies|7387:Angre|7390:Quaregnon|7500:Ere|7501:Orcq|7502:Esplechin|7503:Froyennes|7504:Froidmont|7506:Willemeau|7520:Ramegnies-Chin|7521:Chercq|7522:Blandain|7530:Gaurain-Ramecroix|7531:Havinnes|7532:Beclers|7533:Thimougies|7534:Barry|7536:Vaulx|7538:Vezon|7540:Kain|7542:Mont-Saint-Aubert|7543:Mourcourt|7548:Warchin|7600:PÉruwelz|7601:Roucourt|7602:Bury|7603:Bon-Secours|7604:Baugnies|7608:Wiers|7610:Rumes|7611:La Glanerie|7618:Taintignies|7620:Bléharies|7621:Lesdain|7622:Laplaigne|7623:Rongy|7624:Howardries|7640:Péronnes-Lez-Antoing|7641:Bruyelle|7642:Calonne|7643:Fontenoy|7700:Luingne|7711:Dottenijs|7712:Herseaux|7730:Bailleul|7740:Pecq|7742:Hérinnes-Lez-Pecq|7743:Esquelmes|7750:Amougies|7760:Celles|7780:Komen-Waasten|7781:Houthem|7782:Ploegsteert|7783:Bizet|7784:Neerwaasten|7800:Ath|7801:Irchonwelz|7802:Ormeignies|7803:Bouvignies|7804:Ostiches|7810:Maffle|7811:Arbre|7812:Houtaing|7822:Ghislenghien|7823:Gibecq|7830:Bassilly|7850:Edingen|7860:Lessines|7861:Papignies|7862:Ogy|7863:Ghoy|7864:Deux-Acren|7866:Bois-De-Lessines|7870:Montignies-Lez-Lens|7880:Vloesberg|7890:Ellezelles|7900:Grandmetz|7901:Thieulain|7903:Blicquy|7904:Pipaix|7906:Gallaix|7910:Arc-Wattripont|7911:Frasnes-Lez-Buissenal|7912:Dergneau|7940:Brugelette|7941:Attre|7942:Mévergnies-Lez-Lens|7943:Gages|7950:ChiÈvres|7951:Tongre-Notre-Dame|7970:Beloeil|7971:Basècles|7972:Aubechies|7973:Grandglise|8000:Brugge|8020:Hertsberge|8200:Sint-Andries|8210:Loppem|8211:Aartrijke|8300:Knokke-Heist|8301:Heist-Aan-Zee|8310:Assebroek|8340:Damme|8370:Blankenberge|8377:Houtave|8380:Dudzele|8400:Oostende|8420:De Haan|8421:Vlissegem|8430:Middelkerke|8431:Wilskerke|8432:Leffinge|8433:Mannekensvere|8434:Lombardsijde|8450:Bredene|8460:Ettelgem|8470:Gistel|8480:Bekegem|8490:Jabbeke|8500:Kortrijk|8501:Bissegem|8510:Bellegem|8511:Aalbeke|8520:Kuurne|8530:Harelbeke|8531:Bavikhove|8540:Deerlijk|8550:Zwevegem|8551:Heestert|8552:Moen|8553:Otegem|8554:Sint-Denijs|8560:Gullegem|8570:Anzegem|8572:Kaster|8573:Tiegem|8580:Avelgem|8581:Kerkhove|8582:Outrijve|8583:Bossuit|8587:Spiere-Helkijn|8600:Beerst|8610:Handzame|8620:Nieuwpoort|8630:Avekapelle|8640:Oostvleteren|8647:Lo-Reninge|8650:Houthulst|8660:Adinkerke|8670:Koksijde|8680:Bovekerke|8690:Alveringem|8691:Beveren-Aan-De-Ijzer|8700:Aarsele|8710:Ooigem|8720:Dentergem|8730:Beernem|8740:Egem|8750:Wingene|8755:Ruiselede|8760:Meulebeke|8770:Ingelmunster|8780:Oostrozebeke|8790:Waregem|8791:Beveren|8792:Desselgem|8793:Sint-Eloois-Vijve|8800:Beveren|8810:Lichtervelde|8820:Torhout|8830:Gits|8840:Oostnieuwkerke|8850:Ardooie|8851:Koolskamp|8860:Lendelede|8870:Emelgem|8880:Ledegem|8890:Dadizele|8900:Brielen|8902:Hollebeke|8904:Boezinge|8906:Elverdinge|8908:Vlamertinge|8920:Langemark-Poelkapelle|8930:Lauwe|8940:Geluwe|8950:Heuvelland|8951:Dranouter|8952:Wulvergem|8953:Wijtschate|8954:Westouter|8956:Kemmel|8957:Mesen|8958:Loker|8970:Poperinge|8972:Krombeke|8978:Watou|8980:Beselare|9000:Gent|9030:Mariakerke|9031:Drongen|9032:Wondelgem|9040:Sint-Amandsberg|9041:Oostakker|9042:Desteldonk|9050:Gentbrugge|9051:Afsnee|9052:Zwijnaarde|9060:Zelzate|9070:Destelbergen|9080:Beervelde|9090:Gontrode|9100:Nieuwkerken-Waas|9111:Belsele|9112:Sinaai-Waas|9120:Beveren-Waas|9130:Doel|9140:Elversele|9150:Bazel|9160:Daknam|9170:De Klinge|9180:Moerbeke-Waas|9185:Wachtebeke|9190:Kemzeke|9200:Sint-Gillis-Dendermonde|9220:Hamme|9230:Massemen|9240:Zele|9250:Waasmunster|9255:Buggenhout|9260:Schellebelle|9270:Kalken|9280:Denderbelle|9290:Berlare|9300:Aalst|9308:Gijzegem|9310:Baardegem|9320:Erembodegem|9340:Impe|9400:Appelterre-Eichem|9401:Pollare|9402:Meerbeke|9403:Neigem|9404:Aspelare|9406:Outer|9420:Erpe-Mere|9450:Denderhoutem|9451:Kerksken|9470:Denderleeuw|9472:Iddergem|9473:Welle|9500:Geraardsbergen|9506:Grimminge|9520:Bavegem|9521:Letterhoutem|9550:Herzele|9551:Ressegem|9552:Borsbeke|9570:Sint-Maria-Lierde|9571:Hemelveerdegem|9572:Sint-Martens-Lierde|9600:Ronse|9620:Elene|9630:Beerlegem|9636:Nederzwalm-Hermelgem|9660:Brakel|9661:Parike|9667:Sint-Kornelis-Horebeke|9680:Etikhove|9681:Nukerke|9688:Schorisse|9690:Berchem|9700:Bevere|9750:Huise|9750,9770:Kruisem|9771:Nokere|9772:Wannegem-Lede|9790:Wortegem-Petegem|9800:Astene|9800,9850:Deinze|9810:Eke|9820:Bottelare|9830:Sint-Martens-Latem|9831:Deurle|9840:De Pinte|9850:Hansbeke|9860:Balegem|9870:Machelen|9880:Lotenhulle|9880,9910:Aalter|9881:Bellem|9890:Asper|9900:Eeklo|9910:Ursel|9920:Lovendegem|9920,9930,9950:Lievegem|9921:Vinderhoute|9931:Oostwinkel|9932:Ronsele|9940:Ertvelde|9960:Assenede|9961:Boekhoute|9968:Bassevelde|9970:Kaprijke|9971:Lembeke|9980:Sint-Laureins|9981:Sint-Margriete|9982:Sint-Jan-In-Eremo|9988:Waterland-Oudeman|9990:Maldegem|9991:Adegem|9992:Middelburg".split("|").map((s) => s.split(":")));
const gemeenteVan = (f) => {
  const c = get(f, "city");
  if (c && !/^(zo[ _]snel|binnen|deze|volgende|nog niet|later|\d+[ _]?(maand|week))/i.test(c)) return clean(c);
  const z = (get(f, "zip").match(/\b\d{4}\b/) || [])[0];
  return (z && PC[z]) || "";
};
const get = (f, n) => pick(f, ...FIELDS[n]);
const USED = /first_?name|last_?name|full_?name|volledige_?naam|voornaam|achternaam|mail|phone|telefoon|gsm|post|zip|city|plaats|stad|gemeente|street|straat|adres/i;

// Antwoorden uit Meta leesbaar maken: "20_–_30_m²" -> "20–30 m²", "2_ruimtes" -> "2 ruimtes"
const clean = (v) => String(v || "").replace(/_?–_?/g, "–").replace(/_/g, " ").replace(/\s+/g, " ").trim();
const leeg = (v) => !v || /overslaan|^geen$|^n\.?v\.?t\.?$/i.test(v);

// Vragen van het leadformulier herkennen (aantal ruimtes, m² per ruimte, plaatsing, belmoment)
function vragen(f) {
  const o = { aantal: "", ruimtes: [], plaatsing: "", belmoment: "", rest: [] };
  const kamer = {}; // nr -> { type, m2 }
  for (const [k, v] of Object.entries(f)) {
    if (USED.test(k) && !/ruimte|plaats(en|ing)|bellen|belmoment/i.test(k)) continue;
    const key = k.toLowerCase().replace(/_/g, " ");
    const val = clean(v);
    let m;
    if (/hoeveel ruimtes|aantal ruimtes|hoeveel airco/.test(key)) o.aantal = (val.match(/\d+/) || [val])[0];
    else if ((m = key.match(/ruimte\s*(\d)/))) {
      if (leeg(val)) continue;
      const r = (kamer[m[1]] = kamer[m[1]] || {});
      // m²-antwoord (bv. "20–30 m²", "< 20 m²") of ruimtetype (Living, Keuken, Slaapkamer, ...)
      if (/m²|m2|\d/.test(val) || /groot|m²|m2|oppervlakte/.test(key)) r.m2 = val; else r.type = val;
    }
    else if (/bellen|belmoment|bereikbaar/.test(key)) o.belmoment = val;
    else if (/wanneer|plaats(en|ing)/.test(key)) o.plaatsing = val;
    else if (!USED.test(k)) o.rest.push(`${clean(k).replace(/\?$/, "")}: ${val}`);
  }
  const n = Number(o.aantal) || Object.keys(kamer).length;
  o.ruimtes = Object.keys(kamer).sort().filter((nr) => !n || Number(nr) <= n)
    .map((nr) => `${kamer[nr].type ? kamer[nr].type : "Ruimte " + nr}: ${kamer[nr].m2 || "grootte niet opgegeven"}`);
  return o;
}

function toPayload(lead, formName) {
  const f = fields(lead);
  const full = get(f, "full");
  const voornaam = get(f, "first") || (full.split(" ")[0] || "");
  const achternaam = get(f, "last") || full.split(" ").slice(1).join(" ");
  const q = vragen(f);
  const titel = (formName.split("|").map((s) => s.trim()).filter(Boolean)[2] || "Meta-advertentie").replace(/Mitubishi/i, "Mitsubishi");
  const naamVol = [voornaam, achternaam].filter(Boolean).join(" ");
  const bericht = [
    q.rest.join("\n"),
    [`Formulier: ${formName}`, lead.ad_name ? `Advertentie: ${lead.ad_name}` : "", lead.campaign_name ? `Campagne: ${lead.campaign_name}` : "", `Meta lead-ID: ${lead.id}`].filter(Boolean).join("\n"),
  ].filter(Boolean).join("\n\n");
  return {
    form_name: "offerte",
    data: {
      voornaam, naam: achternaam,
      email: get(f, "email"), telefoon: get(f, "phone"),
      straat: get(f, "street"), postcode: get(f, "zip"), gemeente: gemeenteVan(f),
      systeem: titel,
      aantal: q.aantal ? `${q.aantal} ${Number(q.aantal) === 1 ? "ruimte" : "ruimtes"}` : "",
      ruimtes_m2: q.ruimtes.join("\n"),
      plaatsingsdatum: q.plaatsing, belmoment: q.belmoment,
      bericht,
      bron_pagina: `Meta-advertentie – ${titel} – ${lead.ad_name || ""}`.trim().replace(/ –$/, ""),
      lead_titel: `Meta ${titel} - ${naamVol || "onbekend"}${gemeenteVan(f) ? " (" + gemeenteVan(f) + ")" : ""}`,
      naam_vol: naamVol,
    },
  };
}

// Herstel van leads die vóór v2 met een verkeerde naam (bv. straatnaam) in Odoo kwamen.
const esc = (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const MARKER = "Samenvatting formulier";
function samenvatting(d) {
  const r = (k, v) => v ? `<tr><td style="padding:3px 14px 3px 0;color:#5b6b7a;white-space:nowrap;vertical-align:top">${k}</td><td style="padding:3px 0;vertical-align:top"><b>${esc(v).replace(/\n/g, "<br>")}</b></td></tr>` : "";
  const rows = r("Aantal", d.aantal) + r("Grootte per ruimte", d.ruimtes_m2) + r("Gewenste plaatsing", d.plaatsingsdatum) + r("Gewenst belmoment", d.belmoment);
  return rows ? `<h4 style="margin:0 0 4px;color:#0A1622">${MARKER}</h4><table style="border-collapse:collapse;font-size:14px">${rows}</table><hr>` : "";
}

async function repairLead(call, metaId, p) {
  const ids = await call("crm.lead", "search", [[["description", "ilike", "Meta lead-ID: " + metaId], ["active", "in", [true, false]]]], { limit: 1 });
  if (!ids.length) return false;
  const [cur] = await call("crm.lead", "read", [ids], { fields: ["name", "contact_name", "description"] });
  // v3: oudere leads krijgen bovenaan een leesbare samenvatting (bestaande notities blijven staan)
  let desc = (cur && cur.description) || "";
  if (!desc.includes(MARKER) && !desc.includes("Grootte per ruimte")) {
    const blok = samenvatting(p.data);
    if (blok) { desc = blok + desc; await call("crm.lead", "write", [ids, { description: desc }]); console.log("samenvatting toegevoegd:", ids[0]); }
  }
  if (cur && cur.name === p.data.lead_titel) return false;
  const vals = { name: p.data.lead_titel, contact_name: p.data.naam_vol || false };
  // v3.2: foute gemeente (bv. "zo_snel_mogelijk") ook in de notitie (Adres-regel) vervangen
  const oud = ((cur && cur.name) || "").match(/\(([^()]*)\)\s*$/);
  if (oud && p.data.gemeente && oud[1] !== p.data.gemeente && desc.includes(", " + oud[1])) vals.description = desc.split(", " + oud[1]).join(", " + p.data.gemeente);
  if (p.data.email) vals.email_from = p.data.email;
  if (p.data.telefoon) vals.phone = p.data.telefoon;
  if (p.data.straat) vals.street = p.data.straat;
  if (p.data.postcode) vals.zip = p.data.postcode;
  if (p.data.gemeente) vals.city = p.data.gemeente;
  await call("crm.lead", "write", [ids, vals]);
  console.log("lead hersteld:", ids[0]);
  return true;
}

exports.handler = async (event) => {
  const start = Date.now();
  const kandidaten = []; // voor AFP, pas na de Odoo-ronde
  const token = process.env.META_ACCESS_TOKEN, pageId = process.env.META_PAGE_ID;
  const formIds = (process.env.META_FORM_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!token || !pageId || !formIds.length) { console.log("meta-leads-sync: env vars ontbreken, niets gedaan"); return { statusCode: 200 }; }
  let pageToken = token;
  try { pageToken = (await graph(`${pageId}?fields=access_token`, token)).access_token || token; }
  catch (e) { console.warn("page token niet opgehaald, systeemtoken gebruikt:", e.message); }
  // v3: tot 13/11/2026 eenmalig terugkijken tot de campagnestart (2/11) om oudere leads een samenvatting te geven
  const since = Date.now() < Date.parse("2026-11-13T00:00:00Z")
    ? Math.floor(Date.parse("2026-11-01T00:00:00Z") / 1000)
    : Math.floor(Date.now() / 1000) - LOOKBACK_H * 3600;
  let nieuw = 0, overgeslagen = 0, test = 0;
  const call = await odoo();
  for (const formId of formIds) {
    let form = { name: formId };
    try { form = await graph(`${formId}?fields=name`, pageToken); } catch (e) { console.warn("formnaam:", e.message); }
    const filter = encodeURIComponent(JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: since }]));
    let url = `${formId}/leads?fields=id,created_time,field_data,ad_name,campaign_name&limit=100&filtering=${filter}`;
    while (url) {
      const page = url.startsWith("http") ? await (await fetch(url)).json() : await graph(url, pageToken);
      if (page.error) throw new Error("Meta: " + page.error.message);
      for (const lead of page.data || []) {
        // Meta-testleads (Lead Ads Testing Tool: "<test lead: dummy data ...>", test@meta.com) nooit naar Odoo/mail
        if ((lead.field_data || []).some((f) => (f.values || []).some((v) => /<test lead:|^test@meta\.com$/i.test(v)))) { test++; continue; }
        try {
          const payload = toPayload(lead, form.name || formId);
          const kandidaat = { lead, formName: form.name || formId, formId, payload, nieuwInOdoo: false };
          kandidaten.push(kandidaat);
          if (await odooHasLead(call, lead.id)) { await repairLead(call, lead.id, payload).catch((e) => console.warn("herstel mislukt:", e.message)); overgeslagen++; continue; }
          kandidaat.nieuwInOdoo = true;
          const out = await processLead(payload, { attempts: 1, odooTimeout: 12000, afp: false });
          // titel in Odoo: "Meta Mitsubishi MSZ-HR - naam" i.p.v. "Website aanvraag - naam"
          const leadId = out && out.odoo && out.odoo.leadId;
          if (leadId) await call("crm.lead", "write", [[leadId], { name: payload.data.lead_titel }]).catch((e) => console.warn("titel niet aangepast:", e.message));
          nieuw++;
        } catch (e) { console.error("lead " + lead.id + " mislukt:", e.message); }
      }
      url = (page.paging && page.paging.next) || null;
    }
  }
  console.log(`meta-leads-sync klaar: ${nieuw} nieuw, ${overgeslagen} al in Odoo, ${test} Meta-testlead(s) genegeerd`);
  // AFP: na Odoo, binnen de tijd van de geplande functie (30 s), nooit een fout naar buiten
  let afpRes = null;
  if (afp && afp.ingesteld() && kandidaten.length) {
    try { afpRes = await afp.stuurMetaLeads(kandidaten, { store: afpStore(event), deadline: start + Number(process.env.AFP_BUDGET_MS || 25000) }); }
    catch (e) { console.error("AFP fout (Odoo niet geraakt):", e.message); }
  }
  return { statusCode: 200, body: JSON.stringify({ nieuw, overgeslagen, ...(afpRes ? { afp: afpRes } : {}) }) };
};
