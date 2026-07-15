// Handles both forms on the contact page:
//  - "Book Now" form
//  - "Questions" form
//
// Rules:
//  - Email Address and Re-Enter Email Address cannot be blank.
//  - If the re-entered email doesn't match, tell the visitor right away.
//  - On a valid submit, show a thank-you popup.
//  - Either way, whatever the visitor typed stays in the fields until they
//    navigate to a different page (we never call form.reset()).

function showModal(id) {
    document.getElementById(id).classList.add("show");
}

function closeModal(id) {
    document.getElementById(id).classList.remove("show");
}

function checkEmails(emailId, reEmailId) {
    var email = document.getElementById(emailId).value.trim();
    var reEmail = document.getElementById(reEmailId).value.trim();

    if (email === "" || reEmail === "") {
        return "empty";
    }
    if (email !== reEmail) {
        return "mismatch";
    }
    return "ok";
}

function showEmailError(result) {
    var message = document.getElementById("errorMessage");
    if (result === "empty") {
        message.textContent = "Please fill in both the Email Address and Re-Enter Email Address fields — they can't be left blank.";
    } else {
        message.textContent = "The two email addresses you entered don't match. Please re-enter and try again.";
    }
    showModal("errorModal");
}

function setupFormValidation(formId, emailId, reEmailId, successMessage) {
    var form = document.getElementById(formId);
    if (!form) return;

    var emailField = document.getElementById(emailId);
    var reEmailField = document.getElementById(reEmailId);

    // Immediate check: as soon as the visitor leaves the "re-enter email"
    // field, tell them right away if it doesn't match (only once both
    // fields actually have something in them).
    reEmailField.addEventListener("blur", function () {
        if (emailField.value.trim() !== "" && reEmailField.value.trim() !== "") {
            var result = checkEmails(emailId, reEmailId);
            if (result === "mismatch") {
                showEmailError(result);
            }
        }
    });

    form.addEventListener("submit", function (event) {
        event.preventDefault();

        var result = checkEmails(emailId, reEmailId);
        if (result !== "ok") {
            showEmailError(result);
            return;
        }

        document.getElementById("successMessage").textContent = successMessage;
        showModal("successModal");
        // Intentionally NOT calling form.reset() -- entered info should
        // stay in the fields until the visitor navigates to another page.
    });
}

document.addEventListener("DOMContentLoaded", function () {
    setupFormValidation(
        "bookingForm",
        "email-book",
        "re-email-book",
        "Thank you! An agent will be in touch shortly!"
    );
    setupFormValidation(
        "questionForm",
        "email-q",
        "re-email-q",
        "Thank you! An agent will be in touch shortly!"
    );
});