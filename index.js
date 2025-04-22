require('dotenv').config();
const express = require('express');
const cors = require('cors');
const meetingRoutes = require('./src/routers/meetingRoutes');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded bodies

// API routes
app.use('/api', meetingRoutes);

app.listen(port, () => {
    console.log(`Server running at: ${port}`);
});
