let currentVideoID;

const annotationParser = new AnnotationParser();
let renderer;
let adPlaying = false;

waitForElement(".ytp-right-controls").then(el => {
	const progressButton = document.createElement("button");
	progressButton.classList.add("ytp-button", "ytp-settings-button");

	progressButton.innerHTML = `
<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" fill="white" viewBox="0 0 36 36">
    <path transform="translate(6.5, 6.5)" d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
    <path d="M0 0h24v24H0z" fill="none" />
</svg>
	`;

	progressButton.setAttribute("title", "Annotations aren't found");
	progressButton.setAttribute("aria-label", "Annotations aren't found");

	el.prepend(progressButton);

	progressButton.addEventListener("click", () => {
		if (renderer && renderer.annotations.length) {
			const times = renderer.annotations
				.filter(an => an.data && an.data.hasOwnProperty("timeStart"))
				.sort((a, b) => a.data.timeStart - b.data.timeStart)
				.map(an => {
					let type = an.data.type;
					let style = an.data.style;

					type = type ? type : "";
					style = style ? ", " + style : "";

					const sec = formatSeconds(an.data.timeStart);

					return `${sec} ${type}${style}`;
				}).join("\n");

			alert(times);
		}
		else {
			alert("There are no annotations loaded.");
		}
	});

	window.addEventListener("ar-status-change", e => {
		progressButton.setAttribute("title", e.detail);
		progressButton.setAttribute("aria-label", e.detail);
	});
}).catch(() => {
	console.warn("Unable to find controls area");
});

function formatSeconds(sec) {
    const minutes = Math.floor(sec / 60);
    const seconds = Math.floor(sec % 60);

    const minPadding = minutes < 10 ? "0" : "";
    const secPadding = seconds < 10 ? "0" : "";

    return `${minPadding}${minutes}:${secPadding}${seconds}`;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
	if (request.message === "video_change") {

		window.dispatchEvent(new CustomEvent("ar-status-change", {
			detail: "Video changing..."
		}));

		const currentUrl = new URL(document.URL);
		const videoId = currentUrl.searchParams.get("v");

		const isYoutubeWatchUrl = document.URL.startsWith("https://www.youtube.com/watch?");

		if (videoId && videoId.length === 11 && videoId !== currentVideoID && isYoutubeWatchUrl) {
			currentVideoID = videoId;
			sendResponse(videoId);

			if (renderer) {
				renderer.removeAnnotationElements();
				renderer.annotations = [];
			}
		}
		else {
			sendResponse(false);
		}
	}
	else if (request.type === "check_description_for_annotations") {
		console.info("Checking description for annotations...");
		window.dispatchEvent(new CustomEvent("ar-status-change", {
			detail: "Checking description for annotations..."
		}));


		getFirstValidDescriptionAnnotations().then(data => {
			startNewAnnotationRenderer(data.annotations);
			console.info(`Found ${data.type} annotation data in description`);
			sendResponse({
				foundAnnotations: true
			});
		}).catch(e => {
			console.info(`Retrieving annotations for the current video...`);
			window.dispatchEvent(new CustomEvent("ar-status-change", {
				detail: "Retrieving annotations for the current video...\nThis may sometimes take a little while."
			}));


			sendResponse({
				foundAnnotations: false
			});
		});
		// return true so chrome knows we're responding asynchronously
		return true;
	} 
	else if (request.type === "annotations_received") {
		const annotationData = request.xml;
		if (annotationData) {
			console.info("Received annotation data from server");
			window.dispatchEvent(new CustomEvent("ar-status-change", {
				detail: "Received annotation data from server. Annotations should now be loaded.\nClick to see annotation times."
			}));


			const annotationDom = annotationParser.xmlToDom(annotationData);
			const annotationElements = annotationDom.getElementsByTagName("annotation");

			const annotations = annotationParser.parseYoutubeAnnotationList(annotationElements);
			startNewAnnotationRenderer(annotations);
		}
	} 
	else if (request.type === "annotations_unavailable") {
		console.info("Annotation data for this video is unavailable");
		window.dispatchEvent(new CustomEvent("ar-status-change", {
			detail: "Annotations are not available for this video."
		}));
	} 
	else if (request.type === "remove_renderer_annotations") {
		if (renderer) {
			renderer.stop();
			renderer.removeAnnotationElements();
		}
	}
	// popup annotation loading
	else if (request.type === "popup_load_youtube" && request.data) {
		console.info("Loading youtube data");
		const annotationDom = annotationParser.xmlToDom(request.data);
		const annotationElements = annotationDom.getElementsByTagName("annotation");
		const annotations = annotationParser.parseYoutubeAnnotationList(annotationElements);
		if (!renderer) {
			startNewAnnotationRenderer(annotations);
		} 
		else {
			changeAnnotationData(annotations);
		}
	} 
	else if (request.type === "popup_load_converted" && request.data) {
		console.info("Loading converted data");
		const annotations = annotationParser.deserializeAnnotationList(request.data);
		if (!renderer) {
			startNewAnnotationRenderer(annotations);
		} 
		else {
			changeAnnotationData(annotations);
		}
	}
});

function startNewAnnotationRenderer(annotations) {
	const videoContainer = document.getElementById("movie_player");
	const player = document.querySelector("video.video-stream.html5-main-video");

	const playerOptions = {
		getVideoTime() {
			return player.currentTime;
		},
		seekTo(seconds) {
			player.currentTime = seconds;
		},
		getOriginalVideoWidth() {
			return player.videoWidth;
		},
		getOriginalVideoHeight() {
			return player.videoHeight;
		}
	};

	renderer = new AnnotationRenderer(annotations, videoContainer, playerOptions, 200);
	renderer.start();

	if (videoContainer.classList.contains("ad-showing")) {
		adPlaying = true;
		renderer.annotationsContainer.style.display = "none";
	}
	else if (!player.classList.contains("ad-showing") && adPlaying) {
		adPlaying = false;
		renderer.annotationsContainer.style.display = "block";
	}

	hideAnnotationsDuringAds(videoContainer);
}

// https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver
function hideAnnotationsDuringAds(player) {
	// Select the node that will be observed for mutations
	const targetNode = player;

	// Options for the observer (which mutations to observe)
	const config = { attributes: true, atrributeFilter: ["class"]};

	// Callback function to execute when mutations are observed
	const callback = function(mutationsList) {
		for (let mutation of mutationsList) {
			// ad begins playing
			if (player.classList.contains("ad-showing") && !adPlaying) {
				adPlaying = true;
				renderer.annotationsContainer.style.display = "none";
			}
			// ad is done playing
			else if (!player.classList.contains("ad-showing") && adPlaying) {
				adPlaying = false;
				renderer.annotationsContainer.style.display = "block";
			}
		}
	};

	// Create an observer instance linked to the callback function
	const observer = new MutationObserver(callback);

	// Start observing the target node for configured mutations
	observer.observe(targetNode, config);
}

window.addEventListener("__ar_annotation_click", e => {
	const url = e.detail.url;
	// redirect to the url
	window.location.href = url;
});

function updateAnnotationSizes(delay = 0) {
	setTimeout(() => {
		if (renderer) {
			renderer.updateAllAnnotationSizes();
		}
	}, delay);
}

window.addEventListener("resize", () => {
	updateAnnotationSizes(250);
	updateAnnotationSizes(1000);
});

function changeAnnotationData(annotations) {
	renderer.stop();
	renderer.removeAnnotationElements();
	renderer.createAnnotationElements(annotations);
	renderer.updateAllAnnotationSizes();
	renderer.update();
	renderer.start();
}

function waitForElement(selector, maxRetries=10, intervalAmount=200, intervalStep=200) {
	return new Promise((resolve, reject) => {
		let currentRetries = 0;

		const progInt = setInterval(() => {
			currentRetries++;
			intervalAmount += intervalStep;

			if (currentRetries > maxRetries) {
				reject();
				clearInterval(progInt);
				return;
			}

			const el = document.querySelector(selector);
			if (el) {
				resolve(el);
				clearInterval(progInt);
				return;
			}
		}, intervalAmount);
	});
}

