(async () => {
  const root = document.getElementById("studio-designs"),
    message = document.getElementById("studio-message");
  const params = new URLSearchParams(location.search),
    deleted = params.get("deleted"),
    revision = Number(params.get("revision"));
  if (deleted && /^[0-9a-f-]{36}$/.test(deleted) && revision > 0) {
    message.textContent = "Design deleted.";
    const undo = document.getElementById("undo-delete");
    undo.hidden = false;
    undo.onclick = async () => {
      undo.disabled = true;
      try {
        const response = await fetch(
          location.pathname + "/designs/" + deleted + "/restore",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ revision }),
          },
        );
        if (!response.ok) throw Error(await response.text());
        location.href = (await response.json()).url;
      } catch (e) {
        message.textContent = e.message;
        undo.disabled = false;
      }
    };
  }
  document.getElementById("new-design").onclick = async () => {
    const button = document.getElementById("new-design");
    button.disabled = true;
    try {
      const response = await fetch(location.pathname + "/designs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          template: document.getElementById("new-template").value,
        }),
      });
      if (!response.ok) throw Error(await response.text());
      location.href = (await response.json()).url;
    } catch (e) {
      message.textContent = e.message;
      button.disabled = false;
    }
  };
  if (!window.studioLibrary.length && !deleted)
    message.textContent =
      "Create your first design from event artwork and sponsors.";
  for (const record of window.studioLibrary) {
    const card = document.createElement("a");
    card.className = "studio-card";
    card.href = location.pathname + "/designs/" + record.id;
    const thumb = document.createElement("div");
    thumb.className = "studio-thumbnail";
    const title = document.createElement("h2");
    title.textContent = record.name;
    const meta = document.createElement("p");
    meta.textContent =
      { graphic: "Graphic", video: "Video" }[
        StudioScene.type(record.document)
      ] +
      " · " +
      record.document.template +
      " template" +
      (record.document.needsArrange ? " · setup pending" : "");
    const date = document.createElement("time");
    date.dateTime = record.updated;
    date.textContent = "Saved " + new Date(record.updated).toLocaleString();
    card.append(thumb, title, meta, date);
    root.append(card);
    if (record.document.needsArrange) {
      thumb.textContent = "Finish setup";
      continue;
    }
    try {
      const scene = StudioScene.mount(thumb, record.document);
      scene
        .ready()
        .then((errors) => {
          if (errors.length) meta.textContent += " · artwork needs attention";
        })
        .catch(() => {
          meta.textContent += " · preview unavailable";
        });
    } catch (e) {
      meta.textContent += " · preview unavailable";
    }
  }
})();
