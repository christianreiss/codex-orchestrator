(() => {
  const current = document.documentElement.lang;
  const url = new URL(location.href);
  const requested = url.searchParams.get("lang");
  // English has a dedicated address. The German document doubles as the entry point.
  if (current === "de" && requested !== "de") {
    const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
    const supported = languages.map(tag => tag.toLowerCase().split("-")[0])
      .find(language => language === "de" || language === "en");
    if (supported === "en") {
      const english = new URL("en.html", url);
      english.search = url.search;
      english.hash = url.hash;
      location.replace(english);
      return;
    }
  }

  // Section identifiers are shared between translations.
  for (const link of document.querySelectorAll("[data-language]")) {
    link.addEventListener("click", () => { link.hash = location.hash; });
  }
})();
