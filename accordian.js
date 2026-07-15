var acc = document.getElementsByClassName("accordion");

for (var i = 0; i < acc.length; i++) {
  acc[i].addEventListener("click", function() {
    // 1. Check if the one we just clicked is already open
    var isActive = this.classList.contains("active");

    // 2. Close ALL panels first
    for (var j = 0; j < acc.length; j++) {
      acc[j].classList.remove("active");
      acc[j].nextElementSibling.style.maxHeight = null;
    }

    // 3. If the one we clicked was NOT open, open it now
    if (!isActive) {
      this.classList.toggle("active");
      var panel = this.nextElementSibling;
      // scrollHeight calculates the exact height needed for the text inside
      panel.style.maxHeight = panel.scrollHeight + "px"; 
    }
  })
};