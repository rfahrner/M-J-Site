// Highlights the nav button for the page currently being viewed,
// so visitors can tell at a glance where they are on the site.
document.addEventListener("DOMContentLoaded", function () {
    var page = window.location.pathname.split("/").pop();
    if (!page) {
        page = "index.html"; // covers the root URL with no filename
    }

    var navButtons = document.querySelectorAll("nav .btn-professionalish");
    navButtons.forEach(function (btn) {
        var onclick = btn.getAttribute("onclick") || "";
        if (onclick.indexOf(page) !== -1) {
            btn.classList.add("active-page");
        }
    });
});