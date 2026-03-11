# Academic Writing Guidelines

## Table of Contents
1. Information Integration
2. Section-by-Section Guidelines
3. Writing Quality Standards
4. Citation and References
5. Language and Style
6. Key Writing Constraints

## 1. Information Integration

Before writing, thoroughly analyze and integrate ALL available sources:

### 1.1 Research Results (Primary Data)
- **Data files (CSV, JSON)**: Extract key statistics, trends, patterns, and quantitative findings
- **Figures (PNG, JPG, PDF)**: Use vision to analyze each figure, understand what it shows, write informative captions
- **Log files**: Extract computational parameters, runtime information, convergence data
- **Output files**: Identify main results, error metrics, performance indicators

### 1.2 Background Documents
- **discussion_\*.md**: Extract research motivation, key questions, clarified concepts, research direction
- **detailed_derivations_\*.md**: Incorporate theoretical foundations, mathematical proofs, derivation steps
- **derivation_plan_\*.md**: Understand the logical structure of the theoretical framework

### 1.3 Knowledge Base (if available)
- Search for relevant references to cite
- Find related work to compare and contrast
- Identify the research gap your work addresses

## 2. Section-by-Section Guidelines

### Abstract (200-300 words)
Write a comprehensive summary that stands alone. Include:
- **Background**: Brief context and importance of the topic
- **Purpose**: Clear statement of research objectives
- **Methodology**: Key methods or approaches used
- **Key Results**: Most significant findings with quantitative data if applicable
- **Conclusion**: Main implications and contributions

The abstract should allow readers to understand the paper's essence without reading the full text.

### Introduction
Structure as follows:
- **Hook & Background**: Start broad to introduce context and importance. Engage the reader with the significance of the research area.
- **Problem Statement**: Clearly articulate the specific problem, controversy, or gap in current knowledge.
- **Research Gap**: Critically analyze limitations of previous studies (methodological flaws, sample bias, theoretical gaps) to justify this study.
- **Purpose & Contribution**: State clearly what this study aims to achieve and its expected theoretical or practical contributions.
- **Roadmap**: Briefly outline the structure of the remainder of the paper.

### Background
Provide comprehensive theoretical background:
- Define key concepts and terminology used throughout the paper
- Present the theoretical framework underlying the research
- Review foundational work that this study builds upon
- Establish context necessary for understanding methodology and results

### Literature Review
Organize thematically, NOT just chronologically:
- **Thematic Organization**: Group relevant literature by themes or variables related to the research
- **Critical Analysis**: Evaluate strengths and weaknesses of existing theoretical frameworks. Compare and contrast different scholarly views.
- **Synthesis**: Demonstrate how the study builds upon this foundation to support the hypothesis or model.
- Do NOT simply list summaries of papers. Show how the literature connects to research questions.

### Related Work
Survey existing literature and approaches:
- **Thematic Organization**: Group related work by methodology, application, or theoretical approach
- **Critical Comparison**: Compare and contrast with the proposed work, highlighting similarities and differences
- **Gap Identification**: Clearly show what is missing in existing work that this research addresses

### Methods / Methodology
Provide enough detail for replication:
- **Research Design**: Explain the chosen method (Qualitative, Quantitative, Mixed) and rationale.
- **Participants/Sample**: Describe sample characteristics, sampling method, size, representativeness.
- **Materials & Instruments**: Detail equipment, surveys (including validity/reliability), software, or datasets used.
- **Procedure**: Step-by-step description of the data collection process in chronological order.
- **Data Analysis Strategy**: Explain statistical tests or qualitative frameworks used to analyze data, and justify choices.

### Theoretical Framework
Present the theoretical foundation:
- Introduce main theoretical concepts and their relationships
- Include mathematical derivations and proofs where applicable
- Use proper mathematical notation with LaTeX syntax
- Explain physical or conceptual meaning of key equations
- Connect theory to specific research questions

### Results
Present findings objectively without interpretation:
- **Structured Reporting**: Report findings logically, addressing research questions/hypotheses in order.
- **Visuals**: Use tables and figures where appropriate. Ensure they are captioned and referenced in text.
- **Statistical Reporting**: Accurately report relevant statistics (Means, SD, t-values, p-values, effect sizes, confidence intervals).
- Present data systematically, letting numbers speak for themselves.

### Experiments
Describe experimental work systematically:
- **Setup**: Detailed description of experimental apparatus and conditions
- **Datasets**: Description of data sources, preprocessing, and characteristics
- **Baselines**: Comparison methods and their configurations
- **Evaluation Metrics**: Metrics used and justification for their selection
- **Results**: Present results with appropriate statistical measures

### Discussion
The most critical section for demonstrating depth:
- **Interpretation**: Summarize key findings in plain language. Directly answer the Research Question. State if the hypothesis was supported.
- **Contextualization**: Compare findings with the literature reviewed earlier. Do results validate, contradict, or extend existing theories?
- **Implications**: Discuss theoretical value and practical applications.
- **Limitations**: Honestly reflect on shortcomings (methodological, sample, etc.) and how they might influence results.
- **Future Directions**: Provide concrete suggestions for future research based on limitations and findings.

### Analysis
Provide in-depth analysis:
- Discuss patterns, trends, and insights from the results
- Explain unexpected findings and their potential causes
- Connect findings to theoretical predictions
- Quantify the significance of observations

### Conclusion
Write a strong conclusion:
- Briefly restate main purpose and key findings
- Summarize main contributions of this work
- Provide a strong closing statement emphasizing the ultimate value of the research
- Do NOT introduce new arguments or information
- End with implications for the field or future directions

### References
- Ensure absolute formatting accuracy according to specified style guide
- Include all necessary bibliographic information
- Verify that every in-text citation has a corresponding reference entry

## 3. Writing Quality Standards

### Paragraph Structure
- Write coherent paragraphs of 4-8 sentences each
- Each paragraph should have a clear topic sentence and supporting details
- Use transition phrases between paragraphs for smooth flow
- NO bullet points as primary content structure in main text — write in prose

### Subsection Organization
- Use subsections to break long sections into logical units
- Each subsection should cover a distinct subtopic
- Maintain logical progression within and across subsections

### Depth and Rigor
- Provide sufficient detail for reproducibility
- Support claims with evidence (data, citations, or logical argument)
- Quantify findings whenever possible (exact numbers from data files)
- Acknowledge uncertainty and limitations

## 4. Citation and References

- Use numbered references: [1], [2], etc. in text
- Cite as "Smith et al. [1]" or "as shown in [2]" or "previous work [3, 4]"
- Cite all sources from knowledge base search
- Include DOI or arXiv IDs when available
- Ensure all citations are relevant
- Every in-text citation must have a corresponding reference entry

## 5. Language and Style

- Use formal academic language
- Write in third person or first person plural ("we")
- Be precise and avoid vague statements
- Define all technical terms on first use
- Use consistent terminology throughout
- Avoid colloquialisms and informal expressions

## 6. Key Writing Constraints

- **Role**: Write as a distinguished professor and senior researcher
- **Academic integrity**: Never fabricate citations or references
- **Data fidelity**: Use exact values from provided data files — never invent numbers or results
- **Format**: Pure LaTeX — no Markdown syntax in paper content
- **Structure**: No math expressions in section or subsection titles
- **Content**: Each section must be substantial and contribute meaningfully to the paper
