// password.js
const correctPassword = "nmodha2006"; // your password
let attempts = 3; // maximum attempts allowed

while (attempts > 0) {
    let password = prompt("Please enter the password to view this portfolio:");
    if (password === correctPassword) {
        break; // correct password, allow access
    } else {
        attempts--;
        if (attempts > 0) {
            alert(`Incorrect password. You have ${attempts} attempt(s) left.`);
        } else {
            alert("You do not have access to view this portfolio.");
            window.location.href = "https://www.github.com"; // redirect if failed
        }
    }
}
